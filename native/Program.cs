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
    static readonly HashSet<string> ReadOnlyOperations = new(StringComparer.Ordinal) { "inspect", "capture", "related", "windows", "probe" };
    static readonly HashSet<string> ActionOperations = new(StringComparer.Ordinal) { "click", "setValue", "secondary", "select", "typeText" };
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
                abandoned.GetAwaiter().GetResult();
                if (target != 0)
                {
                    var state = ForegroundReturn.GiveBack(noted, target);
                    try { Write(new { giveBack = state }); Console.Out.Flush(); } catch (IOException) { } // appelant deja parti
                }
                return 0;
            }
            catch (Exception error) when (!acquired) { Write(new { ok = false, error = error.GetType().Name, message = error.Message }); return 1; }
        }
        if (args.Length == 2 && args[0] == "--stop-guard") return EmergencyStop.Guard(args[1]);
        // Processus des motifs UI Automation (voir Background.cs).
        if (args.SequenceEqual(new[] { "--com-worker" })) return ComWorker.Run();
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
        // Un refus avant toute entree n'est jamais un resultat inconnu : aucune entree n'a ete envoyee.
        Exception Refuse(string message) => action ? new ActionRefusedException(message) : new InvalidOperationException(message);
        var hwnd = (nint)request.GetProperty("windowId").GetInt64();
        var app = request.GetProperty("app").GetString() ?? "";
        if (!IsWindow(hwnd)) throw Refuse("Window no longer exists");
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) throw Refuse("Window closed during the request; nothing was sent");
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
                        if (!ComUia.IsClassicCombo(nodes[^1])) throw new ActionRefusedException("Control identity changed; inspect again");
                        ComUia.SynthesizeCombo(identity, nodes[^1]);
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
                if (op == "click" && HiddenOffscreen(target, nodes[0])) throw new ActionRefusedException("Target is off-screen with no visible part in its window; scroll it into view and inspect again");
            }
            catch (Exception error) when (error is not (EmergencyStopException or ActionRefusedException or BackgroundNotApplicableException))
            {
                throw new BackgroundNotApplicableException("Target resolution failed before input: " + error.Message);
            }
            return RunAction(op, mode, target, nodes, hwnd, request);
        }
        finally { identity?.Dispose(); full?.Dispose(); }
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
            windows.Add(new { id = (long)hwnd, pid, ownerChain = chain, className = cls, title = Win32.Title(hwnd), enabled = Win32.IsWindowEnabled(hwnd), popup = Win32.IsTransientPopup(hwnd, cls), z });
            return true;
        }, 0);
        return new { ok = true, boundEnabled = Win32.IsWindowEnabled(bound), windows };
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
            var actual = p.Name switch { "name" => node.Name, "role" => node.Role, "automationId" => node.AutomationId, _ => throw new InvalidOperationException("Unknown selector field") };
            hasField = true; if (actual != p.Value.GetString()) return false;
        }
        if (!hasField) throw new InvalidOperationException("Empty native selector");
        return true;
    }
}
