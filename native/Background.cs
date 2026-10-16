using System.Text.Json;
using System.Windows.Automation;

// Aucune entree n'a ete envoyee : la session peut essayer la technique suivante (entree physique sous jeton).
sealed class BackgroundNotApplicableException(string message) : InvalidOperationException(message);
// Refus avant toute entree (mot de passe, application exclue, identite changee, commande desactivee) : aucun repli.
sealed class ActionRefusedException(string message) : InvalidOperationException(message);

readonly record struct Outcome(string Technique, string Mechanism, string Effect);

// Choix de la technique par famille d'interface, d'apres les mesures du banc NexusClaude (bench/RESULTS.md) :
// - Win32 natif : messages directs (BN_CLICKED, BM_SETCHECK, EM_REPLACESEL, CB/LB_SETCURSEL + notification,
//   TCM_SETCURFOCUS, WM_COMMAND de menu). Jamais UIA Invoke (le proxy Win32 appelle SetForegroundWindow), jamais
//   SelectionItem.Select sur une liste Win32/WinForms (la selection change sans prevenir l'application).
// - WinForms : UIA Invoke/Toggle (BN_CLICKED est sans effet sur une case WinForms), messages pour Edit/ComboBox/ListBox.
// - WPF, UWP/WinUI, Chromium/Electron : UIA COM avec AutoSetFocus = FALSE (Invoke, Toggle, Value, SelectionItem, ExpandCollapse).
// Effet : « applied » = etat relu change comme demande ; « none » = etat relu inchange (rien n'a pris) ;
// « sent » = transmis sans relecture possible (la postcondition de la session decide).
static partial class Program
{
    static readonly HashSet<string> EditClasses = new(StringComparer.Ordinal) { "edit", "richedit", "richedit20a", "richedit20w", "richedit50w", "richeditd2dpt" };
    const string Messages = "background:messages", Uia = "background:uia";

    static object RunAction(string op, string mode, Node target, List<Node> nodes, nint window, JsonElement request)
    {
        var before = Win32.Probe();
        var outcome = mode == "foreground" ? ForegroundAction(op, target) : BackgroundAction(op, target, nodes, window, request);
        // Les messages postes sont traites de facon asynchrone : un court delai attrape une fenetre qui s'active elle-meme.
        Thread.Sleep(30);
        var after = Win32.Probe();
        var targetPid = Win32.ProcessOf(window);
        var taken = after.Foreground != before.Foreground && after.Foreground != 0 && Win32.ProcessOf(after.Foreground) == targetPid;
        return new
        {
            ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect,
            foregroundTaken = taken,
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            // Toute entree (de Julien ou injectee) pendant l'action : les techniques d'arriere-plan n'en injectent aucune.
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    // Repli des observations natives : UIA gere sous le jeton de premier plan commun (prend le premier plan).
    static Outcome ForegroundAction(string op, Node target)
    {
        if (op != "click") throw new BackgroundNotApplicableException("Only a semantic click has a foreground UI Automation path");
        var element = target.Element;
        var framework = element.Current.FrameworkId ?? "";
        // Elements de liste Win32 servis par MSAA : leur action par defaut est un double clic par SendInput.
        if (framework == "Win32" && target.Role == "listitem") throw new BackgroundNotApplicableException("Win32 list items have no safe UI Automation path");
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var p))
        {
            using var token = ForegroundToken.Acquire("UIA Invoke (foreground)");
            ((InvokePattern)p).Invoke();
            return new("foreground:uia", "Invoke", "sent");
        }
        if (target.Role is "edit" or "document")
        {
            using var token = ForegroundToken.Acquire("UIA SetFocus");
            element.SetFocus();
            return new("foreground:uia", "SetFocus", element.Current.HasKeyboardFocus ? "applied" : "sent");
        }
        throw new BackgroundNotApplicableException("No foreground UI Automation path for this control");
    }

    static Outcome BackgroundAction(string op, Node target, List<Node> nodes, nint window, JsonElement request)
    {
        var element = target.Element;
        var own = (nint)element.Current.NativeWindowHandle;
        var framework = element.Current.FrameworkId ?? "";
        var classic = framework is "Win32" or "WinForm";
        var cls = own != 0 ? Win32.BaseClass(own) : "";
        switch (op)
        {
            case "click":
                if (framework == "Win32" && cls == "button") return ButtonClick(own);
                if (classic && target.Role == "listitem")
                {
                    var list = AncestorWindow(target, nodes, "listbox");
                    if (list != 0) return ListBoxSelect(list, target.Name);
                    throw new BackgroundNotApplicableException("Classic list item outside a ListBox: UIA Select would be silent");
                }
                if (classic && target.Role == "tab" && own == 0)
                {
                    var tabs = AncestorWindow(target, nodes, "systabcontrol32");
                    if (tabs != 0) return TabSelect(tabs, SiblingIndex(target, nodes));
                }
                if (framework == "Win32")
                {
                    if (element.TryGetCurrentPattern(TogglePattern.Pattern, out _)) return UiaClick(window, target, invoke: false, select: false);
                    throw new BackgroundNotApplicableException("Win32 control without a silent background technique (UIA Invoke would take the foreground)");
                }
                return UiaClick(window, target, invoke: true, select: framework != "WinForm");
            case "setValue":
            {
                var value = Text(request, "value");
                if (classic && EditClasses.Contains(cls)) return EditReplace(own, value, replaceAll: true);
                if (classic && cls == "combobox") return ComboSetValue(own, value);
                return UiaSetValue(window, target, value);
            }
            case "typeText":
                if (classic && EditClasses.Contains(cls)) return EditReplace(own, Text(request, "text"), replaceAll: false);
                throw new BackgroundNotApplicableException("Background typing needs a native Edit control");
            case "secondary":
                return UiaExpandCollapse(window, target, Text(request, "action"));
            case "select":
            {
                var option = Text(request, "option");
                if (classic && cls == "combobox") return ComboSelect(own, option);
                if (classic && cls == "listbox") return ListBoxSelect(own, option);
                if (classic) throw new BackgroundNotApplicableException("Classic list without a message technique: UIA Select would be silent");
                return UiaSelectOption(window, target, nodes, option);
            }
            default: throw new InvalidOperationException("Unknown native operation");
        }
    }

    static nint AncestorWindow(Node target, List<Node> nodes, string cls)
    {
        foreach (var index in target.Ancestors.Reverse())
        {
            var hwnd = (nint)nodes[index].Element.Current.NativeWindowHandle;
            if (hwnd != 0 && Win32.BaseClass(hwnd) == cls) return hwnd;
        }
        return 0;
    }
    static int SiblingIndex(Node target, List<Node> nodes)
    {
        var parent = target.Ancestors.Length > 0 ? target.Ancestors[^1] : -1;
        var siblings = nodes.Where(n => n.Role == target.Role && (n.Ancestors.Length > 0 ? n.Ancestors[^1] : -1) == parent).ToList();
        return siblings.FindIndex(n => n.Index == target.Index);
    }
    static string Norm(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');
    static string Label(string text) => string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    // Option voulue : egalite exacte unique, sinon egalite sans casse unique ; jamais de correspondance partielle.
    static int MatchOption(IReadOnlyList<string?> items, string wanted)
    {
        var target = Label(wanted);
        var exact = Enumerable.Range(0, items.Count).Where(i => items[i] != null && Label(items[i]!) == target).ToList();
        if (exact.Count == 1) return exact[0];
        if (exact.Count > 1) throw new BackgroundNotApplicableException("Option appears several times; it cannot be chosen safely");
        var loose = Enumerable.Range(0, items.Count).Where(i => items[i] != null && string.Equals(Label(items[i]!), target, StringComparison.OrdinalIgnoreCase)).ToList();
        if (loose.Count == 1) return loose[0];
        throw new BackgroundNotApplicableException(loose.Count > 1 ? "Option is ambiguous" : "Option is absent from the list");
    }

    // ---- Messages Win32 directs ------------------------------------------------------------------------------
    static void NotifyParent(nint control, int code)
    {
        var parent = Win32.GetParent(control);
        if (parent == 0) throw new InvalidOperationException("Control without parent; outcome unknown");
        var id = Win32.GetDlgCtrlID(control) & 0xFFFF;
        Win32.Post(parent, Win32.WM_COMMAND, (code << 16) | id, control);
    }

    static Outcome ButtonClick(nint button)
    {
        if (!Win32.IsWindowEnabled(button)) throw new BackgroundNotApplicableException("Button is disabled");
        var kind = Win32.Style(button) & 0xF;
        if (kind == 7) throw new BackgroundNotApplicableException("Group box is not clickable");
        if (kind is 3 or 6) // BS_AUTOCHECKBOX, BS_AUTO3STATE : la case change d'etat puis notifie, comme un vrai clic.
        {
            var state = Win32.Send(button, Win32.BM_GETCHECK) ?? throw new BackgroundNotApplicableException("Button does not answer");
            var next = (state + 1) % (kind == 6 ? 3 : 2);
            Win32.Send(button, Win32.BM_SETCHECK, next);
            NotifyParent(button, 0 /* BN_CLICKED */);
            return new(Messages, "BM_SETCHECK+BN_CLICKED", Win32.Send(button, Win32.BM_GETCHECK) == next ? "applied" : "sent");
        }
        if (kind == 9) // BS_AUTORADIOBUTTON : les autres boutons radio automatiques du groupe sont decoches.
        {
            var parent = Win32.GetParent(button);
            var others = new List<nint>();
            var current = button;
            for (var i = 0; i < 64; i++)
            {
                current = Win32.GetNextDlgGroupItem(parent, current, false);
                if (current == 0 || current == button) break;
                if (Win32.BaseClass(current) == "button" && (Win32.Style(current) & 0xF) == 9) others.Add(current);
            }
            foreach (var other in others) Win32.Send(other, Win32.BM_SETCHECK, 0);
            Win32.Send(button, Win32.BM_SETCHECK, 1);
            NotifyParent(button, 0);
            return new(Messages, "BM_SETCHECK+BN_CLICKED", Win32.Send(button, Win32.BM_GETCHECK) == 1 ? "applied" : "sent");
        }
        NotifyParent(button, 0);
        return new(Messages, "BN_CLICKED", "sent");
    }

    static List<string?> Items(nint control, uint countMsg, uint lengthMsg, uint textMsg)
    {
        var count = Win32.Send(control, countMsg) ?? throw new BackgroundNotApplicableException("List does not answer");
        if (count < 0 || count > 5000) throw new BackgroundNotApplicableException("List is too large for a message selection");
        var items = new List<string?>((int)count);
        for (var i = 0; i < count; i++) items.Add(Win32.SendGetText(control, lengthMsg, textMsg, i, true));
        return items;
    }
    static Outcome ListBoxSelect(nint list, string option)
    {
        if ((Win32.Style(list) & (Win32.LBS_MULTIPLESEL | Win32.LBS_EXTENDEDSEL)) != 0) throw new BackgroundNotApplicableException("Multiple-selection list");
        if (!Win32.IsWindowEnabled(list)) throw new BackgroundNotApplicableException("List is disabled");
        var index = MatchOption(Items(list, Win32.LB_GETCOUNT, Win32.LB_GETTEXTLEN, Win32.LB_GETTEXT), option);
        Win32.Send(list, Win32.LB_SETCURSEL, index);
        if (Win32.Send(list, Win32.LB_GETCURSEL) != index) return new(Messages, "LB_SETCURSEL", "none");
        NotifyParent(list, 1 /* LBN_SELCHANGE */);
        return new(Messages, "LB_SETCURSEL+LBN_SELCHANGE", "applied");
    }
    static Outcome ComboSelect(nint combo, string option)
    {
        if (!Win32.IsWindowEnabled(combo)) throw new BackgroundNotApplicableException("Combo box is disabled");
        var index = MatchOption(Items(combo, Win32.CB_GETCOUNT, Win32.CB_GETLBTEXTLEN, Win32.CB_GETLBTEXT), option);
        Win32.Send(combo, Win32.CB_SETCURSEL, index);
        if (Win32.Send(combo, Win32.CB_GETCURSEL) != index) return new(Messages, "CB_SETCURSEL", "none");
        NotifyParent(combo, 1 /* CBN_SELCHANGE */);
        return new(Messages, "CB_SETCURSEL+CBN_SELCHANGE", "applied");
    }
    static Outcome ComboSetValue(nint combo, string value)
    {
        var items = Items(combo, Win32.CB_GETCOUNT, Win32.CB_GETLBTEXTLEN, Win32.CB_GETLBTEXT);
        if (items.Count(i => i != null && Label(i) == Label(value)) == 1) return ComboSelect(combo, value);
        var edit = Win32.FindWindowExW(combo, 0, "Edit", null);
        if (edit != 0) return EditReplace(edit, value, replaceAll: true);
        throw new BackgroundNotApplicableException("Value is not one of the combo box options");
    }
    static Outcome EditReplace(nint edit, string text, bool replaceAll)
    {
        var style = Win32.Style(edit);
        if ((style & Win32.ES_PASSWORD) != 0) throw new ActionRefusedException("Password controls require the dedicated supported workflow");
        if ((style & Win32.ES_READONLY) != 0) throw new BackgroundNotApplicableException("Read-only field");
        if (!Win32.IsWindowEnabled(edit)) throw new BackgroundNotApplicableException("Field is disabled");
        var multiline = (style & Win32.ES_MULTILINE) != 0;
        if (!multiline && (text.Contains('\n') || text.Contains('\r'))) throw new BackgroundNotApplicableException("A single-line field cannot receive line breaks in background");
        var payload = multiline ? Norm(text).Replace("\n", "\r\n") : text;
        var before = Norm(Win32.WindowText(edit));
        if (replaceAll && Win32.Send(edit, Win32.EM_SETSEL, 0, -1) is null) throw new BackgroundNotApplicableException("Field does not answer");
        // EM_REPLACESEL se comporte comme une saisie : EN_CHANGE, annulation possible, texte inseré au curseur.
        if (Win32.SendText(edit, Win32.EM_REPLACESEL, 1, payload) is null) throw new InvalidOperationException("Field stopped answering during input; outcome unknown");
        var after = Norm(Win32.SendGetText(edit, Win32.WM_GETTEXTLENGTH, Win32.WM_GETTEXT, 0, false) ?? before);
        var wanted = Norm(text);
        var effect = replaceAll
            ? after == wanted ? "applied" : after == before ? "none" : "sent"
            : after != before && after.Contains(wanted, StringComparison.Ordinal) ? "applied" : after == before ? "none" : "sent";
        return new(Messages, replaceAll ? "EM_SETSEL+EM_REPLACESEL" : "EM_REPLACESEL", effect);
    }
    static Outcome TabSelect(nint tabs, int index)
    {
        var count = Win32.Send(tabs, Win32.TCM_GETITEMCOUNT) ?? throw new BackgroundNotApplicableException("Tab control does not answer");
        if (index < 0 || index >= count) throw new BackgroundNotApplicableException("Tab not found in the control");
        // TCM_SETCURFOCUS choisit l'onglet et notifie le parent (TCN_SELCHANGING/TCN_SELCHANGE), sans souris.
        Win32.Send(tabs, Win32.TCM_SETCURFOCUS, index);
        return new(Messages, "TCM_SETCURFOCUS", Win32.Send(tabs, Win32.TCM_GETCURSEL) == index ? "applied" : "none");
    }

    // Menu Win32 (HMENU) de la fenetre : la commande est postee comme un choix de menu (WM_COMMAND).
    static object MenuCommand(nint window, string path)
    {
        // Une fenetre desactivee (dialogue modal ouvert) n'accepte pas de commande : la poster contournerait la modalite.
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        var menu = Win32.GetMenu(window);
        if (menu == 0 || Win32.GetMenuItemCount(menu) <= 0) throw new BackgroundNotApplicableException("No Win32 menu bar in this window");
        static string Clean(string label)
        {
            var text = label.Split('\t')[0].Replace("&&", "\u0001").Replace("&", "").Replace('\u0001', '&');
            text = Label(text).TrimEnd('.', '…').Trim();
            return text;
        }
        var wanted = path.Split('>').Select(s => Clean(s)).ToArray();
        if (wanted.Length == 0 || wanted.Any(s => s.Length == 0)) throw new InvalidOperationException("Invalid menu path");
        var items = new List<(string[] Path, uint Id, bool Enabled)>();
        void Walk(nint m, string[] prefix, int depth)
        {
            var count = Math.Min(Win32.GetMenuItemCount(m), 256);
            for (var i = 0; i < count; i++)
            {
                var state = Win32.GetMenuState(m, (uint)i, 0x400);
                if ((state & 0x800) != 0) continue; // separateur
                var label = Clean(Win32.MenuLabel(m, i));
                if (label.Length == 0) continue;
                var current = prefix.Append(label).ToArray();
                var sub = Win32.GetSubMenu(m, i);
                if (sub != 0) { if (depth < 6) Walk(sub, current, depth + 1); continue; }
                var id = Win32.GetMenuItemID(m, i);
                if (id != 0 && id != 0xFFFFFFFF) items.Add((current, id, (state & 0x3) == 0));
            }
        }
        Walk(menu, [], 0);
        bool Same(string[] a, string[] b) => a.Length == b.Length && a.Zip(b).All(p => string.Equals(p.First, p.Second, StringComparison.OrdinalIgnoreCase));
        var found = items.Where(i => Same(i.Path, wanted)).ToList();
        if (found.Count == 0) found = items.Where(i => i.Path.Length >= wanted.Length && Same(i.Path[^wanted.Length..], wanted)).ToList();
        if (found.Count == 0) throw new BackgroundNotApplicableException("Menu command not found in the Win32 menu bar");
        if (found.Count > 1) throw new BackgroundNotApplicableException("Menu path is ambiguous; give the full path");
        if (!found[0].Enabled) throw new ActionRefusedException("Menu command is disabled");
        EmergencyStop.ThrowIfStopped();
        var before = Win32.Probe();
        Win32.Post(window, Win32.WM_COMMAND, (nint)(found[0].Id & 0xFFFF), 0);
        Thread.Sleep(30);
        var after = Win32.Probe();
        return new
        {
            ok = true, technique = Messages, mechanism = "WM_COMMAND", effect = "sent",
            foregroundTaken = after.Foreground != before.Foreground && after.Foreground != 0 && Win32.ProcessOf(after.Foreground) == Win32.ProcessOf(window),
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    // ---- UI Automation COM, AutoSetFocus = FALSE, dans un processus qui n'a jamais charge le client gere ----
    // Mesure (fixture WPF et WinForms .NET 8) : des que System.Windows.Automation a servi dans un processus (il y
    // enregistre ses fournisseurs cote client pour tout le processus), un Invoke ou Toggle COM du meme processus
    // active la fenetre cible malgre AutoSetFocus = FALSE. Le meme appel depuis un processus « COM pur » ne prend pas
    // le premier plan. Les motifs passent donc par le processus enfant --com-worker (ComWorker.cs).
    static Outcome UiaClick(nint window, Node target, bool invoke, bool select)
    {
        // Une case a cocher se bascule (Toggle) ; un bouton s'invoque ; un element de liste se selectionne.
        string[] order = target.Role is "checkbox" ? ["toggle", "invoke"] :
            target.Role is "radio" or "listitem" or "tab" or "treeitem" ? ["select", "invoke", "toggle"] : ["invoke", "toggle", "select"];
        order = order.Where(p => (p != "invoke" || invoke) && (p != "select" || select)).ToArray();
        return ComBridge.Call(new { op = "click", windowId = (long)window, runtimeId = target.RuntimeId, order });
    }
    static Outcome UiaSetValue(nint window, Node target, string value) =>
        ComBridge.Call(new { op = "setValue", windowId = (long)window, runtimeId = target.RuntimeId, value });
    static Outcome UiaExpandCollapse(nint window, Node target, string action)
    {
        if (action is not ("Expand" or "Collapse")) throw new BackgroundNotApplicableException("Only Expand and Collapse are background secondary actions");
        return ComBridge.Call(new { op = "expandCollapse", windowId = (long)window, runtimeId = target.RuntimeId, action });
    }
    // Liste ou liste deroulante UIA (WPF, XAML, Chromium) : option deja publiee sous le conteneur, sinon depliage
    // sans focus, choix par SelectionItem, puis repliage si la liste etait repliee.
    static Outcome UiaSelectOption(nint window, Node container, List<Node> nodes, string option)
    {
        var label = Label(option);
        var published = nodes.Where(n => n.Selected != null && n.Ancestors.Contains(container.Index) && Label(n.Name) == label).ToList();
        if (published.Count > 1) throw new BackgroundNotApplicableException("Option appears several times; it cannot be chosen safely");
        if (published.Count == 1) return ComBridge.Call(new { op = "select", windowId = (long)window, runtimeId = published[0].RuntimeId });
        return ComBridge.Call(new { op = "expandSelect", windowId = (long)window, runtimeId = container.RuntimeId, option });
    }
}
