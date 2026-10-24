using System.Diagnostics;
using System.Text.Json;

// Aucune entree n'a ete envoyee : la session peut essayer la technique suivante (entree physique sous jeton).
sealed class BackgroundNotApplicableException(string message) : InvalidOperationException(message);
// Refus avant toute entree (mot de passe, application exclue, identite changee, commande desactivee) : aucun repli.
sealed class ActionRefusedException(string message) : InvalidOperationException(message);

readonly record struct Outcome(string Technique, string Mechanism, string Effect);

// Choix de la technique par famille d'interface, d'apres les mesures du banc NexusClaude (bench/RESULTS.md) :
// - Win32 natif : messages directs (BN_CLICKED, BM_SETCHECK, EM_REPLACESEL, CB/LB_SETCURSEL + notification,
//   CB_SHOWDROPDOWN, TCM_SETCURFOCUS, WM_COMMAND de menu). Jamais UIA Invoke (le proxy Win32 appelle
//   SetForegroundWindow), jamais SelectionItem.Select sur une liste Win32/WinForms (la selection change sans prevenir
//   l'application).
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
        InputStarted = true; // au-dela, toute erreur peut suivre une entree : resultat inconnu
        var before = Win32.Probe();
        bool? takenUnderToken = null;
        string? giveBack = null;
        ChromiumInput.LastTaken = false; ChromiumInput.LastGiveBack = null;
        var outcome = mode == "foreground"
            ? ForegroundAction(op, target, window, request, out takenUnderToken, out giveBack)
            : BackgroundAction(op, target, nodes, window, request);
        // Activation simulee Chromium : prise et restitution temporaires du premier plan rapportees (relecture du 22/10).
        if (mode != "foreground" && (ChromiumInput.LastTaken || ChromiumInput.LastGiveBack is not null))
            (takenUnderToken, giveBack) = (ChromiumInput.LastTaken, ChromiumInput.LastGiveBack);
        // Les messages postes sont traites de facon asynchrone : un court delai attrape une fenetre qui s'active elle-meme.
        Thread.Sleep(30);
        var after = Win32.Probe();
        var targetPid = Win32.ProcessOf(window);
        var taken = takenUnderToken ?? (after.Foreground != before.Foreground && after.Foreground != 0 && Win32.ProcessOf(after.Foreground) == targetPid);
        return new
        {
            ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect,
            foregroundTaken = taken, foregroundReturned = giveBack,
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            // Toute entree (de Julien ou injectee) pendant l'action : les techniques d'arriere-plan n'en injectent aucune.
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    // Repli des observations natives : UIA sous le jeton de premier plan commun (peut prendre le premier plan). Une fois
    // le jeton pris (attente jusqu'a 8 s), la pause de Julien est recontrolee juste avant Invoke ou SetFocus ; la fenetre
    // active notee alors lui est rendue sous le jeton, meme si l'action echoue.
    static Outcome ForegroundAction(string op, Node target, nint window, JsonElement request, out bool? taken, out string? giveBack)
    {
        taken = null; giveBack = null;
        InputStarted = false; // attentes et controles ci-dessous avant toute entree (relecture de Codex du 24/10)
        if (op != "click") throw NothingSent("Only a semantic click has a foreground UI Automation path");
        if (ComUia.IsSynthetic(target.RuntimeId)) throw NothingSent("Combo box options read by messages have no UI Automation path");
        // Elements de liste Win32 servis par MSAA : leur action par defaut est un double clic par SendInput.
        if (target.FrameworkId == "Win32" && target.Role == "listitem") throw NothingSent("Win32 list items have no safe UI Automation path");
        var (purpose, call) = target.HasInvoke ? ("UIA Invoke (foreground)", "invoke")
            : target.Role is "edit" or "document" ? ("UIA SetFocus", "setFocus")
            : throw NothingSent("No foreground UI Automation path for this control");
        int? quietMs = request.TryGetProperty("quietMs", out var q) && q.ValueKind == JsonValueKind.Number ? q.GetInt32() : null;
        using var token = ForegroundToken.Acquire(purpose);
        JulienPause.ThrowIfActive(quietMs);
        EmergencyStop.ThrowIfStopped();
        var noted = Win32.GetForegroundWindow();
        var input = Win32.Probe().LastInput; // UIA n'injecte aucune entree : tout changement vient de Julien ou d'un pair
        InputStarted = true; // l'appel UIA peut agir
        try
        {
            return FirstCall(() => ComBridge.Call(new { op = call, windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow })) with { Technique = "foreground:uia" };
        }
        finally
        {
            Thread.Sleep(30); // une activation postee par le fournisseur arrive de facon asynchrone
            var now = Win32.GetForegroundWindow();
            taken = now != noted && now != 0 && Win32.ProcessOf(now) == Win32.ProcessOf(window);
            giveBack = ForegroundReturn.GiveBack(noted, window, input);
        }
    }

    static Outcome BackgroundAction(string op, Node target, List<Node> nodes, nint window, JsonElement request)
    {
        var own = target.NativeWindow;
        // Chromium (Chrome, Edge, Electron) : surfaces editables et <select> par activation simulee (ChromiumInput.cs,
        // recette commune du banc du 21/10) ; le reste suit les techniques ci-dessous.
        // Fenetre deja au premier plan : voies habituelles (UIA selectOption, etc. ; relecture du 22/10).
        if (ChromiumInput.IsChromium(window) && !ChromiumInput.InForeground(window) && !ComUia.IsSynthetic(target.RuntimeId))
        {
            int? quiet = request.TryGetProperty("quietMs", out var qm) && qm.ValueKind == JsonValueKind.Number ? qm.GetInt32() : null;
            var editable = target.Role is "edit" or "document";
            // Frontiere Chromium : preconditions, jeton, pause de Julien et STOP precedent toute entree ; « entree partie »
            // seulement au premier message d'activation (relecture de Codex du 24/10).
            void Started() => InputStarted = true;
            if (op == "click" && editable) { InputStarted = false; return ChromiumInput.Focus(window, target, quiet, Started).Outcome; }
            if (op == "typeText" && editable) { InputStarted = false; return ChromiumInput.Type(window, target, Text(request, "text"), quiet, Started).Outcome; }
            if (op == "select" && target.Role == "combobox") { InputStarted = false; return ChromiumInput.Select(window, target, Text(request, "option"), quiet, Started).Outcome; }
        }
        var framework = target.FrameworkId;
        var classic = framework is "Win32" or "WinForm";
        var cls = own != 0 ? Win32.BaseClass(own) : "";
        // Noeud synthetique d'une liste deroulante classique : option choisie par la liste deroulante a son rang (homonymes
        // distingues), libelle controle ; champ par messages Edit ; la liste elle-meme n'a pas d'action.
        if (ComUia.IsSynthetic(target.RuntimeId))
        {
            // Element d'une liste WinForms lu par messages : choisi a son rang, libelle relu (homonymes distingues).
            var listBox = target.Ancestors.Length > 0 && ComUia.IsClassicListBox(nodes[target.Ancestors[^1]]) ? nodes[target.Ancestors[^1]].NativeWindow : 0;
            if (listBox != 0)
            {
                if (op == "click" && target.RuntimeId[2] == ComUia.SyntheticItem) return ListBoxSelect(listBox, target.Name, target.RuntimeId[3]);
                throw NothingSent("A list item read by messages only supports a click (selection)");
            }
            var combo = AncestorWindow(target, nodes, "combobox");
            if (combo == 0) throw RefusedBeforeInput("Control identity changed; inspect again");
            if (op == "click" && target.RuntimeId[2] == ComUia.SyntheticItem) return ComboSelect(combo, target.Name, target.RuntimeId[3]);
            if (target.RuntimeId[2] == ComUia.SyntheticEdit && op is ("setValue" or "typeText") && cls == "edit")
                return EditReplace(own, Text(request, op == "setValue" ? "value" : "text"), replaceAll: op == "setValue");
            throw NothingSent("This part of the combo box has no action: choose an option or act on the combo box");
        }
        switch (op)
        {
            case "click":
                if (framework == "Win32" && cls == "button") return ButtonClick(own);
                // Bouton poussoir WinForms (dessine par l'application : BS_OWNERDRAW, ou BS_PUSHBUTTON) : BN_CLICKED POSTE.
                // UIA Invoke est synchrone : un bouton qui ouvre une boite modale le bloque jusqu'a sa fermeture (banc
                // commun des trois NexusWindows, 21/10). Jamais pour une case ou un bouton radio (role != button).
                if (framework == "WinForm" && cls == "button" && target.Role == "button" && (Win32.Style(own) & 0xF) is 0 or 1 or 0xB)
                    return ButtonClick(own);
                if (classic && target.Role == "listitem")
                {
                    var list = AncestorWindow(target, nodes, "listbox");
                    if (list != 0) return ListBoxSelect(list, target.Name);
                    // Element de la liste (ouverte ou non) d'une liste deroulante : choix par la liste deroulante elle-meme.
                    var combo = AncestorWindow(target, nodes, "combobox");
                    if (combo != 0) return ComboSelect(combo, target.Name);
                    throw NothingSent("Classic list item outside a ListBox or ComboBox: UIA Select would be silent");
                }
                if (classic && target.Role == "tab" && own == 0)
                {
                    var tabs = AncestorWindow(target, nodes, "systabcontrol32");
                    if (tabs != 0 && target.Ancestors.Length > 0) return TabSelect(tabs, ComUia.Shared.ChildRank(nodes[target.Ancestors[^1]], target));
                }
                if (framework == "Win32")
                {
                    if (target.HasToggle) return UiaClick(window, target, invoke: false, select: false);
                    throw NothingSent("Win32 control without a silent background technique (UIA Invoke would take the foreground)");
                }
                if (target.Role == "listitem" && AncestorNode(target, nodes, "combobox") is { } container)
                {
                    // Option d'une liste deroulante UIA ouverte : choisie, puis la liste refermee.
                    return FirstCall(() => ComBridge.Call(new { op = "selectItem", windowId = (long)window, runtimeId = target.RuntimeId, containerRuntimeId = container.RuntimeId }));
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
                throw NothingSent("Background typing needs a native Edit control");
            case "secondary":
            {
                var action = Text(request, "action");
                if (classic && cls == "combobox") return ComboDropDown(own, action);
                return UiaExpandCollapse(window, target, action);
            }
            case "select":
            {
                var option = Text(request, "option");
                if (classic && cls == "combobox") return ComboSelect(own, option);
                if (classic && cls == "listbox") return ListBoxSelect(own, option);
                if (classic) throw NothingSent("Classic list without a message technique: UIA Select would be silent");
                return FirstCall(() => ComBridge.Call(new { op = "selectOption", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow, option, combo = target.Role == "combobox" }));
            }
            default: throw new InvalidOperationException("Unknown native operation");
        }
    }

    // Refus d'applicabilite de BackgroundAction/ForegroundAction, leves avant tout appel qui peut agir (seule la mesure
    // Win32.Probe de RunAction les precede) : rien n'est parti, InputStarted redevient faux (relecture de Codex du 24/10 :
    // sinon le client les lisait comme une issue inconnue, sans repli et accord consomme).
    static BackgroundNotApplicableException NothingSent(string message) { InputStarted = false; return new(message); }
    static ActionRefusedException RefusedBeforeInput(string message) { InputStarted = false; return new(message); }
    // Premiere action de RunAction confiee au processus COM : son refus marque « avant tout motif » (beforeInput) precede
    // toute entree de cette requete.
    static Outcome FirstCall(Func<Outcome> call)
    {
        try { return call(); }
        catch (BackgroundNotApplicableException error) when (error.Data["beforeInput"] is true) { throw NothingSent(error.Message); }
        catch (EmergencyStopException error) when (error.Data["beforeInput"] is true) { InputStarted = false; throw; }
    }
    // Lecture prealable d'un auxiliaire (choix d'option sur des libelles lus) : son refus precede toute entree.
    static T PreInput<T>(Func<T> read)
    {
        try { return read(); }
        catch (BackgroundNotApplicableException error) { throw NothingSent(error.Message); }
    }

    static nint AncestorWindow(Node target, List<Node> nodes, string cls)
    {
        foreach (var index in target.Ancestors.Reverse())
        {
            var hwnd = nodes[index].NativeWindow;
            if (hwnd != 0 && Win32.BaseClass(hwnd) == cls) return hwnd;
        }
        return 0;
    }
    static Node? AncestorNode(Node target, List<Node> nodes, string role)
    {
        foreach (var index in target.Ancestors.Reverse()) if (nodes[index].Role == role) return nodes[index];
        return null;
    }
    static string Norm(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');
    internal static string Label(string text) => string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    // Option voulue : egalite exacte unique, sinon egalite sans casse unique ; jamais de correspondance partielle.
    internal static int MatchOption(IReadOnlyList<string?> items, string wanted)
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
        if (!Win32.IsWindowEnabled(button)) throw NothingSent("Button is disabled");
        var kind = Win32.Style(button) & 0xF;
        if (kind == 7) throw NothingSent("Group box is not clickable");
        if (kind is 3 or 6) // BS_AUTOCHECKBOX, BS_AUTO3STATE : la case change d'etat puis notifie, comme un vrai clic.
        {
            var state = Win32.Send(button, Win32.BM_GETCHECK) ?? throw NothingSent("Button does not answer");
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
        var count = Win32.Send(control, countMsg) ?? throw NothingSent("List does not answer");
        if (count < 0 || count > 5000) throw NothingSent("List is too large for a message selection");
        var items = new List<string?>((int)count);
        for (var i = 0; i < count; i++) items.Add(Win32.SendGetText(control, lengthMsg, textMsg, i, true));
        return items;
    }
    static Outcome ListBoxSelect(nint list, string option, int? rank = null)
    {
        if ((Win32.Style(list) & (Win32.LBS_MULTIPLESEL | Win32.LBS_EXTENDEDSEL)) != 0) throw NothingSent("Multiple-selection list");
        if (!Win32.IsWindowEnabled(list)) throw NothingSent("List is disabled");
        // Liste dessinee par l'application (LBS_OWNERDRAWFIXED/VARIABLE) sans LBS_HASSTRINGS : LB_GETTEXT rend les donnees
        // de l'element, pas son libelle ; le choix par libelle serait faux (relecture de Codex, 21/10).
        var style = Win32.Style(list);
        if ((style & 0x30) != 0 && (style & 0x40 /* LBS_HASSTRINGS */) == 0) throw NothingSent("Owner-drawn list without strings: labels cannot be read by messages");
        var items = Items(list, Win32.LB_GETCOUNT, Win32.LB_GETTEXTLEN, Win32.LB_GETTEXT);
        if (rank is { } r && (r < 0 || r >= items.Count || items[r] != option)) throw RefusedBeforeInput("List items changed; inspect again");
        var index = rank ?? PreInput(() => MatchOption(items, option));
        Win32.Send(list, Win32.LB_SETCURSEL, index);
        if (Win32.Send(list, Win32.LB_GETCURSEL) != index) return new(Messages, "LB_SETCURSEL", "none");
        NotifyParent(list, 1 /* LBN_SELCHANGE */);
        return new(Messages, "LB_SETCURSEL+LBN_SELCHANGE", "applied");
    }
    // Choix dans une liste deroulante Win32/WinForms, liste ouverte ou non. Ordre impose : si la liste est ouverte, la
    // FERMER d'abord (CB_SHOWDROPDOWN(FALSE), relu par CB_GETDROPPEDSTATE) ; cette fermeture est une annulation
    // (CBN_SELENDCANCEL) qui rend la selection d'avant l'ouverture : un choix pose avant elle serait perdu (mesure du banc :
    // « Formule= » vide). Puis CB_SETCURSEL relu, et CBN_SELCHANGE + CBN_SELENDOK au parent, comme un choix de l'utilisateur.
    static Outcome ComboSelect(nint combo, string option, int? rank = null)
    {
        if (!Win32.IsWindowEnabled(combo)) throw NothingSent("Combo box is disabled");
        var items = Items(combo, Win32.CB_GETCOUNT, Win32.CB_GETLBTEXTLEN, Win32.CB_GETLBTEXT);
        if (rank is { } r && (r < 0 || r >= items.Count || items[r] != option)) throw RefusedBeforeInput("Combo box options changed; inspect again");
        var index = rank ?? PreInput(() => MatchOption(items, option));
        var dropped = Win32.Send(combo, Win32.CB_GETDROPPEDSTATE) is > 0;
        var mechanism = "CB_SETCURSEL+CBN_SELCHANGE+CBN_SELENDOK";
        if (dropped)
        {
            EmergencyStop.ThrowIfStopped();
            Win32.Send(combo, Win32.CB_SHOWDROPDOWN, 0);
            if (Win32.Send(combo, Win32.CB_GETDROPPEDSTATE) is not 0) throw new InvalidOperationException("The combo box list did not close; outcome unknown");
            mechanism = "CB_SHOWDROPDOWN(FALSE)+" + mechanism;
        }
        EmergencyStop.ThrowIfStopped();
        Win32.Send(combo, Win32.CB_SETCURSEL, index);
        // Liste deja refermee : un echec de selection n'est pas « sans effet » (un repli viserait une liste fermee).
        if (Win32.Send(combo, Win32.CB_GETCURSEL) != index) return new(Messages, mechanism, dropped ? "sent" : "none");
        NotifyParent(combo, 1 /* CBN_SELCHANGE */);
        NotifyParent(combo, 9 /* CBN_SELENDOK */);
        return new(Messages, mechanism, "applied");
    }
    // Ouverture ou fermeture de la liste d'une liste deroulante Win32/WinForms, relue par CB_GETDROPPEDSTATE.
    static Outcome ComboDropDown(nint combo, string action)
    {
        if (action is not ("Expand" or "Collapse")) throw NothingSent("Only Expand and Collapse are background secondary actions");
        if (!Win32.IsWindowEnabled(combo)) throw NothingSent("Combo box is disabled");
        var want = action == "Expand";
        var before = Win32.Send(combo, Win32.CB_GETDROPPEDSTATE) ?? throw NothingSent("Combo box does not answer");
        EmergencyStop.ThrowIfStopped();
        Win32.Send(combo, Win32.CB_SHOWDROPDOWN, want ? 1 : 0);
        var after = Win32.Send(combo, Win32.CB_GETDROPPEDSTATE);
        var effect = after is { } state && (state != 0) == want ? "applied" : after == before ? "none" : "sent";
        return new(Messages, want ? "CB_SHOWDROPDOWN(TRUE)" : "CB_SHOWDROPDOWN(FALSE)", effect);
    }
    static Outcome ComboSetValue(nint combo, string value)
    {
        var items = Items(combo, Win32.CB_GETCOUNT, Win32.CB_GETLBTEXTLEN, Win32.CB_GETLBTEXT);
        if (items.Count(i => i != null && Label(i) == Label(value)) == 1) return ComboSelect(combo, value);
        var edit = Win32.FindWindowExW(combo, 0, "Edit", null);
        if (edit != 0) return EditReplace(edit, value, replaceAll: true);
        throw NothingSent("Value is not one of the combo box options");
    }
    static Outcome EditReplace(nint edit, string text, bool replaceAll)
    {
        var style = Win32.Style(edit);
        if ((style & Win32.ES_PASSWORD) != 0) throw RefusedBeforeInput("Password controls require the dedicated supported workflow");
        if ((style & Win32.ES_READONLY) != 0) throw NothingSent("Read-only field");
        if (!Win32.IsWindowEnabled(edit)) throw NothingSent("Field is disabled");
        var multiline = (style & Win32.ES_MULTILINE) != 0;
        if (!multiline && (text.Contains('\n') || text.Contains('\r'))) throw NothingSent("A single-line field cannot receive line breaks in background");
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
        var count = Win32.Send(tabs, Win32.TCM_GETITEMCOUNT) ?? throw NothingSent("Tab control does not answer");
        if (index < 0 || index >= count) throw NothingSent("Tab not found in the control");
        // TCM_SETCURFOCUS choisit l'onglet et notifie le parent (TCN_SELCHANGING/TCN_SELCHANGE), sans souris.
        Win32.Send(tabs, Win32.TCM_SETCURFOCUS, index);
        return new(Messages, "TCM_SETCURFOCUS", Win32.Send(tabs, Win32.TCM_GETCURSEL) == index ? "applied" : "none");
    }

    // Menu Win32 (HMENU) de la fenetre : la commande est postee comme un choix de menu (WM_COMMAND).
    // Element de menu WinForms designe par son chemin (elements de menu ancetres puis lui, noms et identifiants
    // d'automatisation observes), dans la fenetre liee (barre de menus ou menu contextuel ouvert), invoque par UIA.
    static object MenuItemByPath(nint window, (string Name, string? AutomationId)[] path) => MenuByNames(window, path);

    // Menu WinForms (MenuStrip, ContextMenuStrip) par les noms de son chemin, commande par UIA Invoke (ComWorker.MenuPath).
    static object MenuByNames(nint window, (string Name, string? AutomationId)[] segments)
    {
        var names = segments.Select(s => s.AutomationId is { Length: > 0 } id ? (object)new { name = s.Name, automationId = id } : new { name = s.Name }).ToArray();
        var before = Win32.Probe();
        InputStarted = true;
        var outcome = ComBridge.Call(new { op = "menuPath", windowId = (long)window, runtimeId = Array.Empty<int>(), path = names });
        Thread.Sleep(30);
        var after = Win32.Probe();
        return new
        {
            ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect,
            foregroundTaken = after.Foreground != before.Foreground && after.Foreground != 0 && Win32.ProcessOf(after.Foreground) == Win32.ProcessOf(window),
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    static object MenuCommand(nint window, string path)
    {
        // Une fenetre desactivee (dialogue modal ouvert) n'accepte pas de commande : la poster contournerait la modalite.
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        var menu = Win32.GetMenu(window);
        if (menu == 0 || Win32.GetMenuItemCount(menu) <= 0)
        {
            // Menu WinForms (MenuStrip) : chemin par les noms, commande par UIA Invoke (ComWorker.MenuPath).
            if (!Win32.ClassName(window).StartsWith("WindowsForms10.", StringComparison.Ordinal)) throw new BackgroundNotApplicableException("No Win32 menu bar in this window");
            return MenuByNames(window, path.Split('>').Select(s => (s.Trim(), (string?)null)).ToArray());
        }
        static string Clean(string label)
        {
            var text = label.Split('\t')[0].Replace("&&", "\u0001").Replace("&", "").Replace('\u0001', '&');
            text = Label(text).TrimEnd('.', '…').Trim();
            return text;
        }
        var wanted = path.Split('>').Select(s => Clean(s)).ToArray();
        if (wanted.Length == 0 || wanted.Any(s => s.Length == 0)) throw new InvalidOperationException("Invalid menu path");
        // Chain : sous-menus ouverts pour atteindre la commande (menu parent, rang du sous-menu, sous-menu), puis la
        // commande elle-meme (menu qui la porte, rang).
        var items = new List<(string[] Path, uint Id, nint Menu, int Index, (nint Parent, int Index, nint Sub)[] Chain)>();
        void Walk(nint m, string[] prefix, int depth, (nint, int, nint)[] chain)
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
                if (sub != 0) { if (depth < 6) Walk(sub, current, depth + 1, [.. chain, (m, i, sub)]); continue; }
                var id = Win32.GetMenuItemID(m, i);
                if (id != 0 && id != 0xFFFFFFFF) items.Add((current, id, m, i, chain));
            }
        }
        Walk(menu, [], 0, []);
        bool Same(string[] a, string[] b) => a.Length == b.Length && a.Zip(b).All(p => string.Equals(p.First, p.Second, StringComparison.OrdinalIgnoreCase));
        var found = items.Where(i => Same(i.Path, wanted)).ToList();
        if (found.Count == 0) found = items.Where(i => i.Path.Length >= wanted.Length && Same(i.Path[^wanted.Length..], wanted)).ToList();
        if (found.Count == 0) throw new BackgroundNotApplicableException("Menu command not found in the Win32 menu bar");
        if (found.Count > 1) throw new BackgroundNotApplicableException("Menu path is ambiguous; give the full path");
        var item = found[0];
        // L'etat grise d'une commande n'est fiable qu'apres l'ouverture de son menu : l'application le met a jour en
        // traitant WM_INITMENU puis WM_INITMENUPOPUP (MFC, WinForms MainMenu, Win32). Ces messages lui sont envoyes comme
        // par une vraie ouverture, sans rien afficher ; sans reponse, l'etat est « non verifiable » et rien n'est poste.
        string Unverifiable(string why) => $"Menu command state cannot be verified ({why}); nothing was sent";
        if (Win32.Send(window, Win32.WM_INITMENU, menu) is null) throw new ActionRefusedException(Unverifiable("the application did not answer WM_INITMENU"));
        var opened = new List<nint>();
        try
        {
            foreach (var (_, index, sub) in item.Chain)
            {
                if (Win32.Send(window, Win32.WM_INITMENUPOPUP, sub, index & 0xFFFF) is null) throw new ActionRefusedException(Unverifiable("the application did not answer WM_INITMENUPOPUP"));
                opened.Add(sub);
            }
            // Relecture apres initialisation : la commande doit etre restee a sa place (menus dynamiques reconstruits).
            if (Win32.GetMenuItemID(item.Menu, item.Index) != item.Id || Clean(Win32.MenuLabel(item.Menu, item.Index)) != item.Path[^1])
                throw new ActionRefusedException(Unverifiable("the menu changed while it was initialized; inspect again"));
            var state = Win32.GetMenuState(item.Menu, (uint)item.Index, 0x400);
            if (state == 0xFFFFFFFF) throw new ActionRefusedException(Unverifiable("the command is no longer in its menu"));
            if ((state & 0x3) != 0) throw new ActionRefusedException("Menu command is disabled");
        }
        finally
        {
            // Fermeture symetrique, comme a la destruction d'un menu deroulant reel (sans effet si l'application l'ignore).
            for (var i = opened.Count - 1; i >= 0; i--) Win32.Send(window, Win32.WM_UNINITMENUPOPUP, opened[i]);
        }
        EmergencyStop.ThrowIfStopped();
        var before = Win32.Probe();
        InputStarted = true;
        Win32.Post(window, Win32.WM_COMMAND, (nint)(item.Id & 0xFFFF), 0);
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

    // Apres un geste poste : une application peut s'activer elle-meme en le traitant (Electron sur un clic, WinForms sur
    // un double clic : banc commun du 21/10, premier plan pris 1 a 2 s et jamais rendu). Tout l'intervalle noter /
    // emettre / surveiller / rendre se tient SOUS le jeton de premier plan commun (relecture de Codex : sans lui, un pair
    // qui activait la cible pendant la surveillance se voyait reprendre le premier plan au milieu de son entree). Le
    // premier plan n'est rendu que si personne n'a touche clavier ou souris depuis la note : un clic volontaire de Julien,
    // meme dans l'application cible, est garde (« kept-by-julien »).
    static (Outcome Outcome, bool Taken, string? GiveBack, (nint Foreground, Win32.Point Cursor, uint LastInput) Before) PostedUnderToken(nint window, string purpose, Func<Outcome> send)
    {
        using var token = ForegroundToken.Acquire(purpose);
        EmergencyStop.ThrowIfStopped();
        var before = Win32.Probe();
        Outcome outcome;
        try { outcome = send(); }
        catch when (InputStarted)
        {
            // Entree partielle (controle detruit entre DOWN et UP...) : la cible peut deja s'etre activee. Surveillance et
            // restitution quand meme, sous le jeton, puis l'erreur d'origine remonte telle quelle, sans rejeu.
            Watch();
            throw;
        }
        var pid = Win32.ProcessOf(window);
        var clock = Stopwatch.StartNew();
        var taken = false;
        while (clock.ElapsedMilliseconds < 300)
        {
            var fg = Win32.GetForegroundWindow();
            if (fg != 0 && fg != before.Foreground && Win32.ProcessOf(fg) == pid) { taken = true; break; }
            Thread.Sleep(10);
        }
        if (!taken) return (outcome, false, null, before);
        return (outcome, true, ForegroundReturn.GiveBack(before.Foreground, window, before.LastInput), before);

        void Watch()
        {
            var target = Win32.ProcessOf(window);
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 300)
            {
                var fg = Win32.GetForegroundWindow();
                if (fg != 0 && fg != before.Foreground && Win32.ProcessOf(fg) == target) { ForegroundReturn.GiveBack(before.Foreground, window, before.LastInput); return; }
                Thread.Sleep(10);
            }
        }
    }

    // Clic ou molette a un point d'une capture native (Pointer.cs) : meme compte rendu que les autres actions.
    static object PointAction(nint window, JsonElement request)
    {
        int Int(string key) => request.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        var frame = request.TryGetProperty("frame", out var f) && f.ValueKind == JsonValueKind.Array ? f.EnumerateArray().Select(e => e.GetInt32()).ToArray() : [];
        var action = Text(request, "action", "click");
        var button = Text(request, "button", "left");
        // Clic droit : menus ouverts AVANT, pour lire celui que CE clic ouvre (plan de Codex du 22/10).
        var rightClick = action == "click" && button == "right";
        var menusBefore = rightClick ? Win32.LinkedMenuPopups(window).ToHashSet() : [];
        Pointer.LastTrace = null;
        var (outcome, taken, giveBack, before) = PostedUnderToken(window, "posted pointer (may activate the target)", () =>
            Pointer.Act(window, action, Int("x"), Int("y"), frame, button,
                Math.Max(1, Int("count")), Int("deltaY"), Int("deltaX"), () => InputStarted = true));
        var after = Win32.Probe();
        return new
        {
            ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect,
            foregroundTaken = taken, foregroundReturned = giveBack, trace = Pointer.LastTrace,
            contextMenu = rightClick ? OpenedMenu(window, menusBefore) : null,
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    // Menu contextuel ouvert par UN clic droit : surgissante WinForms liee a la fenetre (meme processus, role menu, meme
    // fil ou possedee), absente avant le clic ; relue jusqu'a son apparition (1 s au plus), jamais un second clic. Ses
    // commandes sont ensuite resolues dans CETTE surgissante (portee de l'observation suivante, MenuSearch.Scope).
    internal static object? OpenedMenu(nint window, HashSet<nint> before)
    {
        var clock = Stopwatch.StartNew();
        while (true)
        {
            var opened = Win32.LinkedMenuPopups(window).Where(h => !before.Contains(h)).ToList();
            if (opened.Count == 1)
            {
                var popup = opened[0];
                return new { id = (long)popup, pid = Win32.ProcessOf(popup), owner = (long)Win32.GetWindow(popup, Win32.GW_OWNER), className = Win32.ClassName(popup) };
            }
            if (opened.Count > 1) return new { ambiguous = opened.Select(h => (long)h).ToArray() };
            if (clock.ElapsedMilliseconds >= 1000) return null;
            Thread.Sleep(20);
        }
    }

    // Touche ou raccourci en arriere-plan (Keys.cs) : meme compte rendu que les autres actions.
    static object KeyAction(nint window, string key)
    {
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        var (outcome, taken, giveBack, before) = PostedUnderToken(window, "posted keys (may activate the target)", () =>
            Keys.Send(window, key, () => InputStarted = true));
        var after = Win32.Probe();
        return new
        {
            ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect,
            foregroundTaken = taken, foregroundReturned = giveBack,
            cursorMoved = before.Cursor.X != after.Cursor.X || before.Cursor.Y != after.Cursor.Y,
            inputDuringAction = before.LastInput != after.LastInput,
            foreground = new { before = (long)before.Foreground, after = (long)after.Foreground },
        };
    }

    // ---- UI Automation COM, AutoSetFocus = FALSE, dans le processus enfant --com-worker ----
    // Mesure (fixture WPF et WinForms .NET 8, 1.3.0) : des que System.Windows.Automation avait servi dans un processus
    // (il y enregistre ses fournisseurs cote client pour tout le processus), un Invoke ou Toggle COM du meme processus
    // activait la fenetre cible malgre AutoSetFocus = FALSE. Depuis 1.4.0 le client gere n'est plus charge du tout (arbre
    // lu par COM) ; les motifs restent dans le processus enfant --com-worker (ComWorker.cs), isole et borne en temps.
    static Outcome UiaClick(nint window, Node target, bool invoke, bool select)
    {
        // Une case a cocher se bascule (Toggle) ; un bouton s'invoque ; un element de liste se selectionne.
        string[] order = target.Role is "checkbox" ? ["toggle", "invoke"] :
            target.Role is "radio" or "listitem" or "tab" or "treeitem" ? ["select", "invoke", "toggle"] : ["invoke", "toggle", "select"];
        order = order.Where(p => (p != "invoke" || invoke) && (p != "select" || select)).ToArray();
        return FirstCall(() => ComBridge.Call(new { op = "click", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow, order }));
    }
    static Outcome UiaSetValue(nint window, Node target, string value) =>
        FirstCall(() => ComBridge.Call(new { op = "setValue", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow, value }));
    static Outcome UiaExpandCollapse(nint window, Node target, string action)
    {
        if (action is not ("Expand" or "Collapse")) throw NothingSent("Only Expand and Collapse are background secondary actions");
        return FirstCall(() => ComBridge.Call(new { op = "expandCollapse", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow, action }));
    }
}
