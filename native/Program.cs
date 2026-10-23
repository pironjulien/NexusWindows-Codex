using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

static partial class Program
{
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(nint process, ref uint length, StringBuilder? appId);
    // Lectures : permises pendant l'arret d'urgence, n'envoient aucune entree.
    static readonly HashSet<string> ReadOnlyOperations = new(StringComparer.Ordinal) { "inspect", "capture", "related", "windows", "probe", "alive" };
    static readonly HashSet<string> ActionOperations = new(StringComparer.Ordinal) { "click", "setValue", "secondary", "select", "typeText", "physical" };
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static string Text(JsonElement e, string key, string fallback = "") => e.TryGetProperty(key, out var v) ? v.GetString() ?? fallback : fallback;
    // Blocage dur : politique commune garde-fous.json (GardeFous.cs). Consoles, terminaux et outils d'administration sont
    // libres depuis l'accord du 18/10 ; seuls restent bloques le bureau securise, les identifiants Windows, les
    // gestionnaires de mots de passe et l'application de Codex lui-meme (ses demandes d'autorisation).
    static string? Exclusion(string processName, nint hwnd) => GardeFous.BlockReason(processName, Win32.ClassName(hwnd));
    // Fenetres console : jamais suivies comme un dialogue apparu pendant une action (elles restent pilotables si on les
    // lie explicitement).
    static readonly HashSet<string> ConsoleClasses = new(StringComparer.OrdinalIgnoreCase)
    { "ConsoleWindowClass", "PseudoConsoleWindow", "CASCADIA_HOSTING_WINDOW_CLASS" };

    [MTAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length is 2 or 3 && args[0] == "--foreground-token")
        {
            // Troisieme argument facultatif : fenetre cible (hwnd). La fenetre active de Julien est notee des le jeton pris
            // et lui est rendue a la fin, sous le jeton, si la cible tient encore le premier plan (ForegroundReturn).
            var target = args.Length == 3 && long.TryParse(args[2], out var hwnd) ? (nint)hwnd : 0;
            bool acquired = false;
            try
            {
                // EOF cancels waiting and releases ownership when the caller dies.
                // Console's synchronized reader can block inside ReadToEndAsync.
                // Keep EOF monitoring on a worker so acquisition can proceed.
                var abandoned = Task.Run(() => Console.In.ReadToEnd());
                using var token = ForegroundToken.Acquire(args[1], abandoned);
                acquired = true;
                var noted = Win32.GetForegroundWindow();
                Write(new { ok = true, foreground = (long)noted });
                Console.Out.Flush();
                var said = abandoned.GetAwaiter().GetResult();
                // Accuse terminal de liberation normale, toujours ecrit (cible ou non) : sans lui, l'appelant tient la
                // fermeture pour une perte du jeton (relecture de Codex, 21/10).
                string? state = null;
                if (target != 0)
                {
                    // « keep » : l'appelant a vu Julien reprendre clavier ou souris pendant le bail (sa presence distingue
                    // les injections de l'agent, que LastInput ne distingue pas) ; son choix est garde.
                    state = said.Contains("keep") ? "kept-by-julien" : ForegroundReturn.GiveBack(noted, target);
                }
                try { Write(new { released = true, giveBack = state }); Console.Out.Flush(); } catch (IOException) { } // appelant deja parti
                return 0;
            }
            catch (Exception error) when (!acquired) { Write(new { ok = false, error = error.GetType().Name, message = error.Message }); return 1; }
        }
        if (args.Length == 2 && args[0] == "--stop-guard") return EmergencyStop.Guard(args[1]);
        // Images de l'indicateur (BGRA premultiplie, bout a bout) pour les tests, sans rien afficher.
        if (args.Length == 3 && args[0] == "--indicator-frames" && int.TryParse(args[1], out var diameter) && diameter is >= 24 and <= 512)
        {
            File.WriteAllBytes(args[2], BusyIndicator.RenderFrames(diameter).SelectMany(f => f).ToArray());
            return 0;
        }
        // Processus des motifs UI Automation (voir Background.cs).
        if (args.SequenceEqual(new[] { "--com-worker" })) return ComWorker.Run();
        if (args.SequenceEqual(new[] { "--cdp-selftest" })) return Cdp.SelfTest(); // tests : choix de page et port, hors ligne
        if (args.SequenceEqual(new[] { "--surface-selftest" })) return Cdp.SurfaceSelfTest(); // tests : zone de rendu de la page, hors ligne
        if (args.SequenceEqual(new[] { "--prove-selftest" })) return Cdp.ProveSelfTest(); // tests : preuve par le titre simulee, hors ligne
        if (args.SequenceEqual(new[] { "--session-selftest" })) return Cdp.SessionSelfTest(); // tests : nettoyage de secours par la vraie connexion, serveur local
        if (args.SequenceEqual(new[] { "--wheel-trace-selftest" })) return Cdp.WheelTraceSelfTest(); // tests : ACK perdu, arret pendant la preparation
        if (args.SequenceEqual(new[] { "--prove-live-selftest" })) return Cdp.ProveLiveSelfTest(); // banc : preuve par le titre sur un vrai navigateur, ruptures provoquees
        if (args.SequenceEqual(new[] { "--wheel-selftest" })) return ScrollPlan.SelfTest(); // tests : sens et extremites, hors ligne
        if (args.SequenceEqual(new[] { "--popup-selftest" })) return Win32.PopupSelfTest(); // tests : surgissantes transitoires, hors ligne
        if (args.SequenceEqual(new[] { "--menu-selftest" })) return MenuSearch.SelfTest(); // tests : chemin de menu, hors ligne
        if (args.SequenceEqual(new[] { "--collapse-selftest" })) return ComWorker.CollapseSelfTest(); // tests : repli relu, hors ligne
        if (args.SequenceEqual(new[] { "--chromium-selftest" })) return ChromiumInput.SelfTest(); // tests : unites et comparaison, hors ligne
        if (args.SequenceEqual(new[] { "--scroll-choice-selftest" })) return ScrollChoice.SelfTest(); // tests : choix du conteneur, hors ligne
        if (args.SequenceEqual(new[] { "--server" }))
        {
            // One sequential MTA worker. Every request reacquires the window and controls.
            // EOF ends the worker if its client disappears; the client also enforces deadlines.
            EmergencyStop.Watch();
            string? line;
            while ((line = Console.ReadLine()) != null) ProcessRequest(line, true);
            return 0;
        }
        return ProcessRequest(Console.In.ReadToEnd(), false);
    }
    static int ProcessRequest(string input, bool server)
    {
        string? requestId = null;
        object result;
        int code = 0;
        try
        {
            if (input.Length > 262144) throw new InvalidOperationException("Request is too large");
            using var json = JsonDocument.Parse(input);
            var request = json.RootElement;
            requestId = Text(request, "requestId");
            if (server && !Guid.TryParse(requestId, out _)) throw new InvalidOperationException("Request identity is required");
            if (request.TryGetProperty("policyFile", out var policy))
            {
                var file = policy.GetString();
                if (string.IsNullOrWhiteSpace(file) || !Path.IsPathFullyQualified(file))
                    throw new InvalidDataException("Policy path must be absolute");
                // Les enfants COM heritent aussi de ce chemin, avec l'environnement Windows complet.
                Environment.SetEnvironmentVariable("NEXUS_GARDE_FOUS", file);
            }
            result = Execute(request);
        }
        catch (Exception error)
        {
            result = new { ok = false, error = error.GetType().Name, message = error.Message };
            code = 1;
        }
        if (server) Write(new { requestId, result }); else Write(result);
        Console.Out.Flush();
        return code;
    }
    // Vrai des qu'une entree a pu partir (RunAction, WM_COMMAND de menu) : avant, toute erreur d'une action precede
    // l'entree.
    [ThreadStatic] static bool InputStarted;
    static object Execute(JsonElement request)
    {
        InputStarted = false;
        var op = Text(request, "operation");
        try { return ExecuteRequest(request, op); }
        catch (Exception error) when (!ReadOnlyOperations.Contains(op) && !InputStarted && error is not (EmergencyStopException or ActionRefusedException or JulienActiveException)
            && request.TryGetProperty("windowId", out var w) && w.ValueKind == JsonValueKind.Number && !IsWindow((nint)w.GetInt64()))
        {
            // Fenetre fermee pendant la requete, avant toute entree : refus (rien n'a ete envoye), jamais un resultat
            // inconnu, et jamais un repli physique vers une fenetre disparue.
            throw new ActionRefusedException("Window closed during the request; nothing was sent: " + error.Message);
        }
    }
    static object ExecuteRequest(JsonElement request, string op)
    {
        var action = !ReadOnlyOperations.Contains(op);
        // Emergency stop: refuse every action before touching the window; inspection stays allowed.
        if (action) EmergencyStop.ThrowIfStopped();
        if (op == "probe")
        {
            var probe = Win32.Probe();
            return new { ok = true, foreground = (long)probe.Foreground, foregroundPid = probe.Foreground == 0 ? 0 : Win32.ProcessOf(probe.Foreground),
                cursor = new { x = probe.Cursor.X, y = probe.Cursor.Y }, idleMs = unchecked(Win32.GetTickCount() - probe.LastInput) };
        }
        if (op == "windows") return ListWindows(request.GetProperty("processId").GetInt32());
        if (op == "openSettings") return OpenSettings(request.GetProperty("uri").GetString() ?? "",
            request.TryGetProperty("quietMs", out var oq) && oq.ValueKind == JsonValueKind.Number ? oq.GetInt32() : null);
        // Un refus avant toute entree n'est jamais un resultat inconnu : aucune entree n'a ete envoyee.
        Exception Refuse(string message) => action ? new ActionRefusedException(message) : new InvalidOperationException(message);
        var hwnd = (nint)request.GetProperty("windowId").GetInt64();
        var app = request.GetProperty("app").GetString() ?? "";
        // Identite imposee par la session (fenetre absente de Sky) : meme processus, meme proprietaire, a chaque requete.
        long? expectedPid = request.TryGetProperty("expectedPid", out var ep) && ep.ValueKind == JsonValueKind.Number ? ep.GetInt64() : null;
        long? expectedOwner = request.TryGetProperty("expectedOwner", out var eo) && eo.ValueKind == JsonValueKind.Number ? eo.GetInt64() : null;
        long? expectedAnchor = request.TryGetProperty("expectedAnchor", out var ea) && ea.ValueKind == JsonValueKind.Number ? ea.GetInt64() : null;
        if (op == "alive") return Alive(hwnd, app, expectedPid, expectedOwner, expectedAnchor);
        if (!IsWindow(hwnd)) throw Refuse("Window no longer exists");
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) throw Refuse("Window closed during the request; nothing was sent");
        if (expectedPid is { } wantedPid && pid != wantedPid) throw Refuse("Window identity changed (other process); nothing was sent");
        if (expectedOwner is { } wantedOwner && (long)Win32.GetWindow(hwnd, Win32.GW_OWNER) != wantedOwner) throw Refuse("Window identity changed (other owner); nothing was sent");
        if (expectedAnchor is { } wantedAnchor && !OwnedThrough(hwnd, wantedAnchor)) throw Refuse("Window identity changed (no longer owned by the followed window); nothing was sent");
        Process OpenProcess()
        {
            try { return Process.GetProcessById((int)pid); }
            catch (ArgumentException) { throw Refuse("The window's process ended during the request; nothing was sent"); }
        }
        using var process = OpenProcess();
        if (Exclusion(process.ProcessName, hwnd) is { } refusal) throw Refuse(refusal);
        var actualApp = AppId(process);
        UiTree? full = null, identity = null;
        try
        {
            UiTree Full() => full ??= ComUia.Shared.ReadTree(hwnd);
            var contentPid = (int)pid;
            if (!string.Equals(app, actualApp, StringComparison.OrdinalIgnoreCase) && process.ProcessName.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
            {
                var matches = new List<int>();
                foreach (var candidate in Full().Nodes.Select(n => n.ProcessId).Where(p => p != 0).Distinct())
                {
                    using var child = Process.GetProcessById(candidate);
                    if (string.Equals(AppId(child), app, StringComparison.OrdinalIgnoreCase)) matches.Add(candidate);
                }
                if (matches.Count == 1) { actualApp = app; contentPid = matches[0]; }
            }
            if (!string.Equals(app, actualApp, StringComparison.OrdinalIgnoreCase))
                throw Refuse($"Window application identity differs: {actualApp}");
            if (op == "capture") return Capture.Window(hwnd, Text(request, "directory"));
            if (op == "related") return Related(hwnd, pid);
            if (op == "menu") return MenuCommand(hwnd, Text(request, "path"));
            if (op == "key") return KeyAction(hwnd, Text(request, "key"));
            if (op == "point") return PointAction(hwnd, request);
            // Vraie souris et vrai clavier du helper, sous le jeton tenu par l'appelant (Physical.cs).
            // Sans cible native : point d'une capture, touche ou texte. Avec cible : resolue ci-dessous, puis relue sous le
            // jeton apres la mise au premier plan.
            if (op == "physical" && !request.TryGetProperty("selector", out _)) return Physical.Act(hwnd, request, () => InputStarted = true);
            if (op == "activate") return Physical.Activate(hwnd, () => InputStarted = true);
            if (op == "navigateFolder") return Explorer.Navigate(hwnd, Text(request, "path"), () => InputStarted = true);
            if (action && !ActionOperations.Contains(op)) throw new InvalidOperationException("Unknown native operation");
            if (op == "inspect")
            {
                var clock = Stopwatch.StartNew();
                var read = Full().Nodes;
                return Inspect(read, contentPid, actualApp, pid, clock.ElapsedMilliseconds);
            }

            // Actions. Observation native (identite d'execution et chaine des ancetres fournies) : relecture limitee a la
            // cible et a ses ancetres, comparee a ce que la session a vu. Observation Sky : arbre complet, selecteur.
            // Toute impossibilite a ce stade precede l'entree : technique suivante permise ou refus.
            var mode = Text(request, "mode", "background");
            if (mode is not ("background" or "foreground")) throw new InvalidOperationException("Unknown action mode");
            var selector = request.GetProperty("selector");
            // Element de menu WinForms (MenuStrip, menu contextuel ContextMenuStrip) : ses identites UIA changent a chaque
            // lecture (banc commun du 21/10 : « Target is no longer present »). Designe par son NOM, unique dans la fenetre
            // liee, et invoque par UIA (ComWorker.MenuPath), comme le chemin de menu.
            // Contraintes stables gardees (relecture de Codex du 22/10) : nom, identifiant d'automatisation, et le contexte du
            // menu (elements de menu ancetres observes, dans l'ordre) ; un ancetre exige par le selecteur doit y figurer.
            if (op == "click" && mode == "background" && Win32.ClassName(hwnd).StartsWith("WindowsForms10.", StringComparison.Ordinal) &&
                selector.TryGetProperty("role", out var menuRole) && menuRole.GetString() == "menuitem" &&
                selector.TryGetProperty("name", out var menuName) && menuName.GetString() is { Length: > 0 })
            {
                if (!Win32.IsWindowEnabled(hwnd)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
                var observed = request.TryGetProperty("ancestry", out var anc0) && anc0.ValueKind == JsonValueKind.Array ? anc0.EnumerateArray().ToList() : [];
                // Commande d'un menu contextuel ou deroulant ouvert : resolue dans CETTE surgissante (HWND lu a l'observation),
                // encore ouverte, du meme processus et liee a la fenetre suivie ; sinon refus (observer de nouveau).
                var scope = (nint)MenuSearch.Scope(hwnd, observed);
                // Menu exige par le selecteur (ancestor.window : celui que le clic droit a ouvert) : la portee DOIT etre lui.
                if (selector.TryGetProperty("ancestor", out var within) && within.TryGetProperty("window", out var menu) &&
                    menu.ValueKind == JsonValueKind.Number && menu.GetInt64() != (long)scope)
                    throw new ActionRefusedException("The command is not in the required open menu; inspect again");
                if (scope != hwnd && !(Win32.IsWindowVisible(scope) && Win32.ProcessOf(scope) == Win32.ProcessOf(hwnd) && Win32.IsTransientPopup(scope, Win32.ClassName(scope), hwnd)))
                    throw new ActionRefusedException("The open menu of this command is closed or no longer linked to the window; inspect again");
                return MenuItemByPath(scope, MenuSearch.Segments(observed, selector));
            }
            (Node Target, List<Node> Nodes) Resolve()
            {
            Node target;
            List<Node> nodes;
            try
            {
                var rid = request.TryGetProperty("runtimeId", out var r) && r.ValueKind == JsonValueKind.Array ? r.EnumerateArray().Select(e => e.GetInt32()).ToArray() : null;
                var ancestry = request.TryGetProperty("ancestry", out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().ToList() : null;
                var hint = request.TryGetProperty("nativeWindow", out var h) && h.ValueKind == JsonValueKind.Number ? (nint)h.GetInt64() : 0;
                if (rid != null && ancestry != null)
                {
                    // Noeud synthetique (option d'une liste deroulante classique) : identite relue sur la liste deroulante qui
                    // le porte (dernier ancetre reel), puis ses options relues par messages.
                    var synthetic = ComUia.IsSynthetic(rid);
                    var anchor = synthetic ? ancestry.FindLastIndex(e => !ComUia.IsSynthetic(RuntimeIdOf(e))) : -1;
                    if (synthetic && anchor < 0) throw new ActionRefusedException("Control identity changed; inspect again");
                    try { identity = synthetic ? ComUia.Shared.ReadIdentity(hwnd, RuntimeIdOf(ancestry[anchor]), (nint)(uint)rid[1]) : ComUia.Shared.ReadIdentity(hwnd, rid, hint); }
                    catch (Exception error) when (error is not (EmergencyStopException or ActionRefusedException or BackgroundNotApplicableException))
                    {
                        throw new BackgroundNotApplicableException("Accessibility identity unavailable for a background action: " + error.Message);
                    }
                    nodes = identity.Nodes;
                    if (synthetic)
                    {
                        if (ComUia.IsClassicCombo(nodes[^1])) ComUia.SynthesizeCombo(identity, nodes[^1]);
                        else if (ComUia.IsClassicListBox(nodes[^1])) ComUia.SynthesizeListBox(identity, nodes[^1]);
                        else throw new ActionRefusedException("Control identity changed; inspect again");
                    }
                    target = nodes.FirstOrDefault(n => n.RuntimeId.SequenceEqual(rid)) ?? throw new ActionRefusedException("Control identity changed; inspect again");
                    if (!Matches(target, selector) || (selector.TryGetProperty("ancestor", out var anc) && !target.Ancestors.Any(i => Matches(nodes[i], anc))))
                        throw new ActionRefusedException("Control identity changed; inspect again");
                    if (!SameAncestry(nodes, target, ancestry)) throw new ActionRefusedException("Control ancestry changed; inspect again");
                }
                else
                {
                    try { nodes = Full().Nodes; }
                    catch (Exception error) when (error is not EmergencyStopException)
                    {
                        throw new BackgroundNotApplicableException("Accessibility tree unavailable for a background action: " + error.Message);
                    }
                    var targets = nodes.Where(n => Matches(n, selector) && (!selector.TryGetProperty("ancestor", out var anc) || n.Ancestors.Any(i => Matches(nodes[i], anc)))).ToArray();
                    // Meme regle que lib/tree.mjs findElements : libelle homonyme d'un seul controle ecarte (sans role).
                    if (targets.Length > 1 && !selector.TryGetProperty("role", out _) && targets.Count(n => n.Role != "text") == 1)
                        targets = targets.Where(n => n.Role != "text").ToArray();
                    if (targets.Length != 1) throw new BackgroundNotApplicableException($"Semantic target count is {targets.Length}; expected one");
                    target = targets[0];
                    if (rid != null && !rid.SequenceEqual(target.RuntimeId)) throw new ActionRefusedException("Control identity changed; inspect again");
                }
                ClassicCombos(nodes);
                EmergencyStop.ThrowIfStopped(); // Reading the tree can take time: check again just before the input.
                if (nodes[0].Disabled || target.Disabled) throw new ActionRefusedException("Target or its window is disabled (a modal dialog may be open)");
                if (target.Password) throw new ActionRefusedException("Password controls require the dedicated supported workflow");
                if (op == "secondary" && !target.Actions.Contains(Text(request, "action"))) throw new ActionRefusedException("Secondary action is not exposed");
                // Visible d'abord (meme regle que les autres agents) : un element hors champ dont rien ne recoupe sa fenetre
                // n'est jamais clique par cible ; le faire defiler, puis reobserver.
                if (op is "click" or "physical" && HiddenOffscreen(target, nodes[0])) throw new ActionRefusedException("Target is off-screen with no visible part in its window; scroll it into view and inspect again");
            }
            catch (Exception error) when (error is not (EmergencyStopException or ActionRefusedException or BackgroundNotApplicableException))
            {
                throw new BackgroundNotApplicableException("Target resolution failed before input: " + error.Message);
            }
            return (target, nodes);
            }
            var (target, nodes) = Resolve();
            if (op == "physical")
            {
                // Clic droit ou double sur une cible native : relue sous le jeton APRES la mise au premier plan (identite,
                // ascendance, rectangle frais), au centre de sa partie visible ; changee ou cachee : refus avant entree.
                return Physical.Act(hwnd, request, () => InputStarted = true, () =>
                {
                    identity?.Dispose(); identity = null; full?.Dispose(); full = null;
                    var (fresh, freshNodes) = Resolve();
                    return VisibleCenter(fresh, freshNodes[0]);
                });
            }
            return RunAction(op, mode, target, nodes, hwnd, request);
        }
        finally { identity?.Dispose(); full?.Dispose(); }
    }

    // Centre de la partie visible de la cible dans sa fenetre (rectangles UIA [x, y, largeur, hauteur], pixels reels).
    static (int X, int Y) VisibleCenter(Node target, Node root)
    {
        if (target.Bounds is not [var x, var y, var w, var h] || w <= 0 || h <= 0) throw new ActionRefusedException("The native target has no on-screen rectangle: observe a native screenshot");
        double left = x, top = y, right = x + w, bottom = y + h;
        if (root.Bounds is [var rx, var ry, var rw, var rh] && rw > 0 && rh > 0)
            (left, top, right, bottom) = (Math.Max(left, rx), Math.Max(top, ry), Math.Min(right, rx + rw), Math.Min(bottom, ry + rh));
        if (right <= left || bottom <= top) throw new ActionRefusedException("Target is off-screen with no visible part in its window; scroll it into view and inspect again");
        return ((int)Math.Round((left + right) / 2), (int)Math.Round((top + bottom) / 2));
    }

    static object Inspect(List<Node> nodes, int contentPid, string actualApp, uint pid, long treeMs)
    {
        ClassicCombos(nodes);
        var tree = new StringBuilder();
        foreach (var n in nodes)
        {
            tree.Append(' ', n.Depth * 2).Append(n.Index).Append(' ').Append(n.Role);
            if (n.Disabled) tree.Append(" (disabled)");
            if (n.Selected == true) tree.Append(" (selected)");
            if (n.Checked == true) tree.Append(" (checked)");
            if (n.Expanded == true) tree.Append(" (expanded)");
            if (n.Expanded == false) tree.Append(" (collapsed)");
            if (n.Offscreen) tree.Append(" (offscreen)");
            tree.Append(' ').Append(Clean(n.Name));
            if (n.Value is { Length: > 0 }) tree.Append(" Value: ").Append(Clean(n.Value));
            if (n.ValueTruncated) tree.Append(" [value truncated]");
            if (n.AutomationId.Length > 0) tree.Append(" ID: ").Append(Clean(n.AutomationId));
            if (n.Actions.Count > 0) tree.Append(" Secondary Actions: ").Append(string.Join(", ", n.Actions));
            tree.AppendLine();
        }
        // Some providers mark both a container and its descendant as focused.
        var focused = nodes.Where(n => n.Focused)
            .OrderByDescending(n => n.Role is "edit" or "document").ThenByDescending(n => n.Depth).FirstOrDefault();
        var document = focused?.Value ?? "";
        var documentTruncated = focused?.ValueTruncated ?? false;
        if (focused != null && !focused.Password && focused.HasText && ComUia.DocumentText(focused.Element) is { } text)
        {
            document = text;
            documentTruncated = document.Length > ComUia.MaxText;
            if (documentTruncated) document = document[..ComUia.MaxText];
        }
        var executable = ImagePath(contentPid) ?? throw new InvalidOperationException("Application binary unavailable");
        var revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(executable + ":" + File.GetLastWriteTimeUtc(executable).Ticks + ":" + new FileInfo(executable).Length))).ToLowerInvariant();
        return new { ok = true, processId = pid, app = actualApp, revision, treeMs,
            accessibility = new { tree = tree.ToString(), focused_element = focused == null ? null : $"{focused.Index} {focused.Role} {focused.Name}", document_text = document, document_truncated = documentTruncated },
            elements = nodes.Select(n => new { index = n.Index, depth = n.Depth * 2, role = n.Role, name = n.Name, automationId = n.AutomationId,
                value = n.Value, valueTruncated = n.ValueTruncated, description = n.Description, disabled = n.Disabled, selected = n.Selected, @checked = n.Checked,
                expanded = n.Expanded, focused = n.Focused, password = n.Password, actions = n.Actions, ancestors = n.Ancestors, runtimeId = n.RuntimeId,
                nativeWindow = (long)n.NativeWindow, bounds = n.Bounds,
                accessKey = n.AccessKey, isDefault = n.IsDefault, invoke = n.HasInvoke, flags = n.Offscreen ? new[] { "offscreen" } : Array.Empty<string>() }).ToList() }; // avant la liberation de l'arbre
    }

    // Liste deroulante Win32/WinForms (classe COMBOBOX, hors CBS_SIMPLE) : l'etat ouvert est relu par CB_GETDROPPEDSTATE,
    // et l'ouverture ou la fermeture se fait par CB_SHOWDROPDOWN (Background.cs), que le fournisseur UIA expose ou non
    // le motif ExpandCollapse.
    static void ClassicCombos(List<Node> nodes)
    {
        foreach (var n in nodes)
        {
            if (!ComUia.IsClassicCombo(n) || Win32.Send(n.NativeWindow, Win32.CB_GETDROPPEDSTATE) is not { } dropped) continue;
            n.Expanded = dropped != 0;
            n.Actions.RemoveAll(a => a is "Expand" or "Collapse");
            n.Actions.Add(dropped != 0 ? "Collapse" : "Expand");
        }
    }

    // Hors champ (IsOffscreen) et sans aucune partie dans le rectangle de sa fenetre (racine) ; rectangles [x, y, l, h].
    static bool HiddenOffscreen(Node target, Node root)
    {
        if (!target.Offscreen) return false;
        if (target.Bounds.Length != 4 || root.Bounds.Length != 4) return true;
        var (x, y, w, h) = (target.Bounds[0], target.Bounds[1], target.Bounds[2], target.Bounds[3]);
        var (rx, ry, rw, rh) = (root.Bounds[0], root.Bounds[1], root.Bounds[2], root.Bounds[3]);
        return x >= rx + rw || y >= ry + rh || x + w <= rx || y + h <= ry;
    }

    // La chaine relue (racine .. parent de la cible) doit etre exactement celle que la session a observee.
    static bool SameAncestry(List<Node> nodes, Node target, List<JsonElement> expected)
    {
        if (expected.Count != target.Ancestors.Length) return false;
        for (var i = 0; i < expected.Count; i++)
        {
            var e = expected[i];
            var n = nodes[target.Ancestors[i]];
            if (Text(e, "role") != n.Role || Text(e, "automationId") != n.AutomationId || Text(e, "name") != n.Name) return false;
            if (!RuntimeIdOf(e).SequenceEqual(n.RuntimeId)) return false;
        }
        return true;
    }
    static int[] RuntimeIdOf(JsonElement e) =>
        e.TryGetProperty("runtimeId", out var r) && r.ValueKind == JsonValueKind.Array ? r.EnumerateArray().Select(x => x.GetInt32()).ToArray() : [];

    // Fenetres de premier niveau liees a la fenetre de reference : possedees (chaine des proprietaires) ou du meme
    // processus. Le choix de suivre l'une d'elles revient a la session (apparue pendant l'action, ou possedee).
    // « popup » : surgissante sans barre de titre qui ne s'active pas (liste deroulante, infobulle, surgissante WPF) ou
    // liste d'une liste deroulante Win32 (ComboLBox) : partie transitoire de la fenetre, lue par l'arbre de son
    // proprietaire et jamais suivie comme une nouvelle fenetre.
    static readonly HashSet<string> IgnoredClasses = new(StringComparer.OrdinalIgnoreCase) { "tooltips_class32", "IME", "MSCTFIME UI", "SysShadow", "ForegroundStaging" };
    static object Related(nint bound, uint boundPid)
    {
        var windows = new List<object>();
        var z = 0;
        Win32.EnumWindows((hwnd, _) =>
        {
            z++;
            if (hwnd == bound || !Win32.IsWindowVisible(hwnd)) return true;
            var chain = new List<long>();
            for (var owner = Win32.GetWindow(hwnd, Win32.GW_OWNER); owner != 0 && chain.Count < 16; owner = Win32.GetWindow(owner, Win32.GW_OWNER)) chain.Add(owner);
            var pid = Win32.ProcessOf(hwnd);
            if (pid != boundPid && !chain.Contains(bound)) return true;
            var cls = Win32.ClassName(hwnd);
            if (IgnoredClasses.Contains(cls) || ConsoleClasses.Contains(cls) || !Win32.GetWindowRect(hwnd, out var rect) || rect.Empty) return true;
            windows.Add(new { id = (long)hwnd, pid, ownerChain = chain, className = cls, title = Win32.Title(hwnd), enabled = Win32.IsWindowEnabled(hwnd), popup = Win32.IsTransientPopup(hwnd, cls, bound), z });
            return true;
        }, 0);
        return new { ok = true, boundEnabled = Win32.IsWindowEnabled(bound), boundPid, windows };
    }
    // Page des Parametres (ms-settings:...) ouverte comme le ferait Demarrer > Executer, sous le jeton commun de premier
    // plan. Lancee par un processus d'arriere-plan, Windows l'ouvre souvent MASQUEE (CoreWindow jamais montree, mesure
    // du 23/10) ; si elle vient devant, le premier plan est rendu a Julien (ForegroundReturn, qui ne reprend rien s'il a
    // touche clavier ou souris). Rend la fenetre des Parametres (cadre montre, sinon la masquee), son application et son
    // processus. Seul le schema ms-settings: est permis : aucun autre protocole (appel, envoi, paiement) ni programme
    // (passe 2 du 22/10 : Sky refusait ms-settings:display).
    static object OpenSettings(string uri, int? quietMs)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(uri, "^ms-settings:[A-Za-z0-9-]*$"))
            throw new ActionRefusedException("Only ms-settings: pages can be opened here; nothing was launched");
        // Politique commune lue AVANT le lancement (illisible : refus, fail closed) et appliquee a la cible Parametres.
        if (GardeFous.BlockReason("SystemSettings", "Windows.UI.Core.CoreWindow") is { } blocked) throw new ActionRefusedException(blocked + "; nothing was launched");
        using var token = ForegroundToken.Acquire("open a Settings page");
        JulienPause.ThrowIfActive(quietMs); // l'attente du jeton peut durer : la pause de Julien est relue sous le jeton
        EmergencyStop.ThrowIfStopped();
        var before = Win32.Probe();
        string giveBack = "none";
        // Le premier plan est rendu CHAQUE fois que les Parametres le prennent, jusqu'a la fin, erreur comprise (relecture
        // de Codex : une seule restitution laissait les Parametres devant s'ils le reprenaient).
        void ReturnIfTaken()
        {
            var fg = Win32.GetForegroundWindow();
            if (fg != 0 && fg != before.Foreground && IsSettings(fg)) giveBack = ForegroundReturn.GiveBack(before.Foreground, fg, before.LastInput);
        }
        nint found = 0;
        var stable = false;
        try
        {
            InputStarted = true;
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true })?.Dispose();
            var clock = Stopwatch.StartNew();
            long foundAt = 0;
            while (clock.ElapsedMilliseconds < 5000)
            {
                ReturnIfTaken();
                var current = SettingsWindow();
                if (current == 0) { found = 0; foundAt = 0; } // candidat disparu : rien n'est retenu
                else if (current != found) { found = current; foundAt = clock.ElapsedMilliseconds; }
                if (found != 0 && clock.ElapsedMilliseconds - foundAt >= 600) { stable = true; break; } // le cadre montre remplace la masquee
                Thread.Sleep(30);
            }
        }
        finally { ReturnIfTaken(); }
        // Identite reattestee juste avant de rendre, et rendue telle qu'attestee : processus lu AVANT l'attestation, relu
        // APRES ; s'il a change (HWND recycle), issue inconnue, jamais le nouveau proprietaire (relecture de Codex). Fenetre
        // non stabilisee 600 ms avant le delai : inconnue aussi.
        if (!stable || found == 0) return new { ok = true, opened = (bool?)null, window = 0L, foregroundReturned = giveBack };
        var pid = Win32.ProcessOf(found);
        if (pid == 0 || !IsWindow(found) || !IsSettings(found) || Win32.ProcessOf(found) != pid)
            return new { ok = true, opened = (bool?)null, window = 0L, foregroundReturned = giveBack };
        using var process = Process.GetProcessById((int)pid);
        if (Win32.ProcessOf(found) != pid) return new { ok = true, opened = (bool?)null, window = 0L, foregroundReturned = giveBack };
        return new { ok = true, opened = (bool?)true, window = (long)found, title = Win32.Title(found), app = AppId(process), pid,
            hidden = !Win32.IsWindowVisible(found), foregroundReturned = giveBack };
    }
    static bool IsSettings(nint hwnd)
    {
        if (ProcessName(Win32.ProcessOf(hwnd)) == "SystemSettings") return true;
        var hosted = false; // cadre ApplicationFrameHost : son contenu (CoreWindow) appartient a SystemSettings
        Win32.EnumChildWindows(hwnd, (child, _) => { if (ProcessName(Win32.ProcessOf(child)) == "SystemSettings") { hosted = true; return false; } return true; }, 0);
        return hosted;
    }
    static nint SettingsWindow()
    {
        nint shown = 0, hidden = 0;
        Win32.EnumWindows((hwnd, _) =>
        {
            if (Win32.ClassName(hwnd) == "ApplicationFrameWindow" && Win32.IsWindowVisible(hwnd) && IsSettings(hwnd)) { shown = hwnd; return false; }
            if (hidden == 0 && Win32.ClassName(hwnd) == "Windows.UI.Core.CoreWindow" && ProcessName(Win32.ProcessOf(hwnd)) == "SystemSettings") hidden = hwnd;
            return true;
        }, 0);
        return shown != 0 ? shown : hidden;
    }
    static string ProcessName(uint pid)
    {
        if (pid == 0) return "";
        try { using var p = Process.GetProcessById((int)pid); return p.ProcessName; } catch (ArgumentException) { return ""; }
    }

    // Existence de la fenetre liee, sans la lire : « gone » seulement si Windows dit le HWND detruit (ou sans
    // processus) ; HWND repris par une autre application : « other » (l'ancienne n'existe plus sous ce numero). Jamais
    // deduit d'une erreur de transport, d'une absence chez Sky ni d'une fenetre masquee (relecture de Codex, 22/10).
    // La fenetre suivie (ancre) est-elle encore dans la chaine des proprietaires ?
    static bool OwnedThrough(nint hwnd, long anchor)
    {
        var depth = 0;
        for (var owner = Win32.GetWindow(hwnd, Win32.GW_OWNER); owner != 0 && depth < 16; owner = Win32.GetWindow(owner, Win32.GW_OWNER), depth++)
            if ((long)owner == anchor) return true;
        return false;
    }
    static object Alive(nint hwnd, string app, long? expectedPid = null, long? expectedOwner = null, long? expectedAnchor = null)
    {
        if (!IsWindow(hwnd)) return new { ok = true, state = "gone" };
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) return new { ok = true, state = "gone" };
        // HWND repris par une autre fenetre (autre processus ou autre proprietaire) : l'ancienne n'existe plus.
        if ((expectedPid is { } wantedPid && pid != wantedPid) || (expectedOwner is { } wantedOwner && (long)Win32.GetWindow(hwnd, Win32.GW_OWNER) != wantedOwner)
            || (expectedAnchor is { } wantedAnchor && !OwnedThrough(hwnd, wantedAnchor)))
            return new { ok = true, state = "other" };
        try
        {
            using var process = Process.GetProcessById((int)pid);
            var same = string.Equals(AppId(process), app, StringComparison.OrdinalIgnoreCase)
                || process.ProcessName.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase);
            return new { ok = true, state = same ? "alive" : "other", visible = Win32.IsWindowVisible(hwnd) };
        }
        catch (ArgumentException) { return new { ok = true, state = "gone" }; }
    }
    static object ListWindows(int processId)
    {
        using var process = Process.GetProcessById(processId);
        var app = AppId(process);
        var windows = new List<object>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (Win32.IsWindowVisible(hwnd) && Win32.ProcessOf(hwnd) == processId)
            {
                var cls = Win32.ClassName(hwnd);
                if (!IgnoredClasses.Contains(cls) && GardeFous.BlockReason(process.ProcessName, cls) == null) windows.Add(new { id = (long)hwnd, app, title = Win32.Title(hwnd) });
            }
            return true;
        }, 0);
        return new { ok = true, windows };
    }
    static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value, Json));
    static string Clean(string value) => value.Replace('\r', ' ').Replace('\n', ' ');
    static string AppId(Process process)
    {
        uint length = 0;
        if (GetApplicationUserModelId(process.Handle, ref length, null) == 122 && length > 0)
        {
            var id = new StringBuilder((int)length);
            if (GetApplicationUserModelId(process.Handle, ref length, id) == 0) return id.ToString();
        }
        return "process:" + (ImagePath(process.Id) ?? throw new InvalidOperationException("Process path unavailable"));
    }
    // Chemin de l'executable (QueryFullProcessImageName : sans enumerer les modules du processus).
    [DllImport("kernel32.dll", SetLastError = true)] static extern nint OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(nint process, uint flags, StringBuilder name, ref uint size);
    static string? ImagePath(int pid)
    {
        var handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (handle == 0) return null;
        try
        {
            var buffer = new StringBuilder(32768);
            var size = (uint)buffer.Capacity;
            return QueryFullProcessImageNameW(handle, 0, buffer, ref size) ? buffer.ToString(0, (int)size) : null;
        }
        finally { CloseHandle(handle); }
    }
    static bool Matches(Node node, JsonElement selector)
    {
        bool hasField = false;
        foreach (var p in selector.EnumerateObject())
        {
            if (p.Name == "ancestor") continue;
            if (p.Name == "window") { hasField = true; if (p.Value.ValueKind != JsonValueKind.Number || (long)node.NativeWindow != p.Value.GetInt64()) return false; continue; }
            var actual = p.Name switch { "name" => node.Name, "role" => node.Role, "automationId" => node.AutomationId, _ => throw new InvalidOperationException("Unknown selector field") };
            hasField = true; if (actual != p.Value.GetString()) return false;
        }
        if (!hasField) throw new InvalidOperationException("Empty native selector");
        return true;
    }
}
