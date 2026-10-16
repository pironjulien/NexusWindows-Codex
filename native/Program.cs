using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Windows.Automation;

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
    static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
    { "cmd", "powershell", "pwsh", "WindowsTerminal", "OpenConsole", "Codex", "ChatGPT", "LockApp", "LogonUI", "consent", "CredentialUIBroker", "SecHealthUI", "SecurityHealthHost", "KeePass", "KeePassXC", "1Password", "Bitwarden", "LastPass" };

    [MTAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 2 && args[0] == "--foreground-token")
        {
            try
            {
                // EOF cancels waiting and releases ownership when the caller dies.
                // Console's synchronized reader can block inside ReadToEndAsync.
                // Keep EOF monitoring on a worker so acquisition can proceed.
                var abandoned = Task.Run(() => Console.In.ReadToEnd());
                using var token = ForegroundToken.Acquire(args[1], abandoned);
                Write(new { ok = true });
                Console.Out.Flush();
                abandoned.GetAwaiter().GetResult();
                return 0;
            }
            catch (Exception error) { Write(new { ok = false, error = error.GetType().Name, message = error.Message }); return 1; }
        }
        if (args.Length == 2 && args[0] == "--stop-guard") return EmergencyStop.Guard(args[1]);
        // Processus COM pur : ne doit jamais charger System.Windows.Automation (voir Background.cs).
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
    static object Execute(JsonElement request)
    {
        var op = Text(request, "operation");
        var action = !ReadOnlyOperations.Contains(op);
        // Emergency stop: refuse every action before touching the window; inspection stays allowed.
        if (action) EmergencyStop.ThrowIfStopped();
        if (op == "probe")
        {
            var probe = Win32.Probe();
            return new { ok = true, foreground = (long)probe.Foreground, cursor = new { x = probe.Cursor.X, y = probe.Cursor.Y }, idleMs = unchecked(Win32.GetTickCount() - probe.LastInput) };
        }
        if (op == "windows") return ListWindows(request.GetProperty("processId").GetInt32());
        // Un refus avant toute entree n'est jamais un resultat inconnu : aucune entree n'a ete envoyee.
        Exception Refuse(string message) => action ? new ActionRefusedException(message) : new InvalidOperationException(message);
        var hwnd = (nint)request.GetProperty("windowId").GetInt64();
        var app = request.GetProperty("app").GetString() ?? "";
        if (!IsWindow(hwnd)) throw Refuse("Window no longer exists");
        GetWindowThreadProcessId(hwnd, out var pid);
        using var process = Process.GetProcessById((int)pid);
        if (Excluded.Contains(process.ProcessName)) throw Refuse("This application requires its dedicated supported tool");
        var actualApp = AppId(process);
        AutomationElement? root = null;
        List<Node>? read = null;
        List<Node> Nodes() => read ??= Read(root ??= AutomationElement.FromHandle(hwnd) ?? throw new InvalidOperationException("No UI Automation root"));
        var contentPid = (int)pid;
        if (!string.Equals(app, actualApp, StringComparison.OrdinalIgnoreCase) && process.ProcessName.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
        {
            var matches = new List<int>();
            foreach (var candidate in Nodes().Select(n => n.Element.Current.ProcessId).Distinct())
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
        List<Node> nodes;
        try { nodes = Nodes(); }
        catch (Exception error) when (action && error is not EmergencyStopException)
        {
            throw new BackgroundNotApplicableException("Accessibility tree unavailable for a background action: " + error.Message);
        }
        if (op == "inspect")
        {
            var tree = new StringBuilder();
            foreach (var n in nodes)
            {
                tree.Append(' ', n.Depth * 2).Append(n.Index).Append(' ').Append(n.Role);
                if (n.Disabled) tree.Append(" (disabled)");
                if (n.Selected == true) tree.Append(" (selected)");
                if (n.Checked == true) tree.Append(" (checked)");
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
            if (focused != null && !focused.Password && focused.Element.TryGetCurrentPattern(TextPattern.Pattern, out var text))
            {
                document = ((TextPattern)text).DocumentRange.GetText(32769);
                documentTruncated = document.Length > 32768;
                if (documentTruncated) document = document[..32768];
            }
            using var contentProcess = Process.GetProcessById(contentPid);
            var executable = contentProcess.MainModule?.FileName ?? throw new InvalidOperationException("Application binary unavailable");
            var revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(executable + ":" + File.GetLastWriteTimeUtc(executable).Ticks + ":" + new FileInfo(executable).Length))).ToLowerInvariant();
            return new { ok = true, processId = pid, app = actualApp, revision,
                accessibility = new { tree = tree.ToString(), focused_element = focused == null ? null : $"{focused.Index} {focused.Role} {focused.Name}", document_text = document, document_truncated = documentTruncated },
                elements = nodes.Select(n => new { index = n.Index, depth = n.Depth * 2, role = n.Role, name = n.Name, automationId = n.AutomationId,
                    value = n.Value, valueTruncated = n.ValueTruncated, description = n.Description, disabled = n.Disabled, selected = n.Selected, @checked = n.Checked,
                    focused = n.Focused, password = n.Password, actions = n.Actions, ancestors = n.Ancestors, runtimeId = n.RuntimeId,
                    bounds = n.Bounds, flags = Array.Empty<string>() }) };
        }
        // Actions : la cible est retrouvee par son selecteur (observation Sky) ou verifiee par son identite d'execution
        // (observation native). Toute impossibilite a ce stade precede l'entree : technique suivante permise ou refus.
        var mode = Text(request, "mode", "background");
        if (mode is not ("background" or "foreground")) throw new InvalidOperationException("Unknown action mode");
        var selector = request.GetProperty("selector");
        Node target;
        try
        {
            var targets = nodes.Where(n => Matches(n, selector) && (!selector.TryGetProperty("ancestor", out var a) || n.Ancestors.Any(i => Matches(nodes[i], a)))).ToArray();
            if (targets.Length != 1) throw new BackgroundNotApplicableException($"Semantic target count is {targets.Length}; expected one");
            target = targets[0];
            EmergencyStop.ThrowIfStopped(); // Reading the tree can take seconds: check again just before the input.
            if (!root!.Current.IsEnabled || target.Disabled || !target.Element.Current.IsEnabled) throw new ActionRefusedException("Target or its window is disabled (a modal dialog may be open)");
            if (target.Password || target.Element.Current.IsPassword) throw new ActionRefusedException("Password controls require the dedicated supported workflow");
            if (request.TryGetProperty("runtimeId", out var rid) && rid.ValueKind == JsonValueKind.Array &&
                !rid.EnumerateArray().Select(e => e.GetInt32()).SequenceEqual(target.RuntimeId)) throw new ActionRefusedException("Control identity changed; inspect again");
            if (op == "secondary" && !target.Actions.Contains(Text(request, "action"))) throw new ActionRefusedException("Secondary action is not exposed");
        }
        catch (Exception error) when (error is not (EmergencyStopException or ActionRefusedException or BackgroundNotApplicableException))
        {
            throw new BackgroundNotApplicableException("Target resolution failed before input: " + error.Message);
        }
        return RunAction(op, mode, target, nodes, hwnd, request);
    }

    // Fenetres de premier niveau liees a la fenetre de reference : possedees (chaine des proprietaires) ou du meme
    // processus. Le choix de suivre l'une d'elles revient a la session (apparue pendant l'action, ou possedee).
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
            if (IgnoredClasses.Contains(cls) || !Win32.GetWindowRect(hwnd, out var rect) || rect.Empty) return true;
            windows.Add(new { id = (long)hwnd, pid, ownerChain = chain, className = cls, title = Win32.Title(hwnd), enabled = Win32.IsWindowEnabled(hwnd), z });
            return true;
        }, 0);
        return new { ok = true, boundEnabled = Win32.IsWindowEnabled(bound), windows };
    }
    static object ListWindows(int processId)
    {
        using var process = Process.GetProcessById(processId);
        if (Excluded.Contains(process.ProcessName)) throw new InvalidOperationException("This application requires its dedicated supported tool");
        var app = AppId(process);
        var windows = new List<object>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (Win32.IsWindowVisible(hwnd) && Win32.ProcessOf(hwnd) == processId && !IgnoredClasses.Contains(Win32.ClassName(hwnd)))
                windows.Add(new { id = (long)hwnd, app, title = Win32.Title(hwnd) });
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
        return "process:" + (process.MainModule?.FileName ?? throw new InvalidOperationException("Process path unavailable"));
    }
    sealed class Node
    {
        public required AutomationElement Element;
        public int Index, Depth;
        public required string Role, Name, AutomationId, Description;
        public string? Value;
        public bool Disabled, Focused, Password, ValueTruncated;
        public bool? Selected, Checked;
        public required int[] RuntimeId, Ancestors;
        public required double[] Bounds;
        public List<string> Actions = new();
    }
    static string Role(ControlType type) => type.Id switch
    {
        50000 => "button", 50002 => "checkbox", 50003 => "combobox", 50004 => "edit", 50005 => "link",
        50007 => "listitem", 50008 => "list", 50009 => "menu", 50011 => "menuitem", 50013 => "radio",
        50014 => "scrollbar", 50015 => "slider", 50019 => "tab", 50020 => "text", 50023 => "tree",
        50024 => "treeitem", 50030 => "document", 50032 => "window", 50033 => "pane", 50026 => "group",
        _ => type.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant()
    };
    static List<Node> Read(AutomationElement root)
    {
        var nodes = new List<Node>(); var walker = TreeWalker.ControlViewWalker;
        void Visit(AutomationElement element, int depth, int[] ancestors)
        {
            if (nodes.Count >= 4096 || depth > 64) throw new InvalidOperationException("Accessibility tree exceeds inspection bound; target a smaller window");
            var p = element.Current;
            // Password controls expose only their identity, never their value.
            string? value = null;
            if (!p.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern, out var vp)) value = ((ValuePattern)vp).Current.Value;
            else if (!p.IsPassword && p.ControlType == ControlType.Document && element.TryGetCurrentPattern(TextPattern.Pattern, out var text)) value = ((TextPattern)text).DocumentRange.GetText(32769);
            var valueTruncated = value is { Length: > 32768 };
            if (value is { Length: > 32768 }) value = value[..32768];
            bool? selected = element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sp) ? ((SelectionItemPattern)sp).Current.IsSelected : null;
            bool? check = element.TryGetCurrentPattern(TogglePattern.Pattern, out var tp)
                ? ((TogglePattern)tp).Current.ToggleState switch { ToggleState.On => true, ToggleState.Off => false, _ => null }
                : null;
            var bounds = p.BoundingRectangle;
            var node = new Node { Element = element, Index = nodes.Count, Depth = depth, Role = Role(p.ControlType), Name = p.Name,
                AutomationId = p.AutomationId, Value = value, ValueTruncated = valueTruncated, Description = p.HelpText, Disabled = !p.IsEnabled,
                Selected = selected, Checked = check, Focused = p.HasKeyboardFocus, Password = p.IsPassword, RuntimeId = element.GetRuntimeId(),
                Ancestors = ancestors, Bounds = bounds.IsEmpty ? [] : [bounds.X, bounds.Y, bounds.Width, bounds.Height] };
            if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep))
            {
                var state = ((ExpandCollapsePattern)ep).Current.ExpandCollapseState;
                if (state == ExpandCollapseState.Collapsed) node.Actions.Add("Expand");
                if (state == ExpandCollapseState.Expanded) node.Actions.Add("Collapse");
            }
            nodes.Add(node);
            var child = walker.GetFirstChild(element);
            while (child != null)
            {
                Visit(child, depth + 1, [.. ancestors, node.Index]);
                child = walker.GetNextSibling(child);
            }
        }
        Visit(root, 0, []); return nodes;
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
