using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Windows.Automation;

static class Program
{
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(nint process, ref uint length, StringBuilder? appId);
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static string Text(JsonElement e, string key, string fallback = "") => e.TryGetProperty(key, out var v) ? v.GetString() ?? fallback : fallback;
    static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
    { "cmd", "powershell", "pwsh", "WindowsTerminal", "OpenConsole", "Codex", "ChatGPT", "LockApp", "LogonUI", "consent", "CredentialUIBroker", "SecHealthUI", "SecurityHealthHost", "KeePass", "KeePassXC", "1Password", "Bitwarden", "LastPass" };

    [MTAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.SequenceEqual(new[] { "--server" }))
        {
            // One sequential MTA worker. Every request reacquires the window and controls.
            // EOF ends the worker if its client disappears; the client also enforces deadlines.
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
        var hwnd = (nint)request.GetProperty("windowId").GetInt64();
        var app = request.GetProperty("app").GetString() ?? "";
        if (!IsWindow(hwnd)) throw new InvalidOperationException("Window no longer exists");
        GetWindowThreadProcessId(hwnd, out var pid);
        using var process = Process.GetProcessById((int)pid);
        if (Excluded.Contains(process.ProcessName)) throw new InvalidOperationException("This application requires its dedicated supported tool");
        var actualApp = AppId(process);
        var root = AutomationElement.FromHandle(hwnd) ?? throw new InvalidOperationException("No UI Automation root");
        var nodes = Read(root);
        var contentPid = (int)pid;
        if (!string.Equals(app, actualApp, StringComparison.OrdinalIgnoreCase) && process.ProcessName.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
        {
            var matches = new List<int>();
            foreach (var candidate in nodes.Select(n => n.Element.Current.ProcessId).Distinct())
            {
                using var child = Process.GetProcessById(candidate);
                if (string.Equals(AppId(child), app, StringComparison.OrdinalIgnoreCase)) matches.Add(candidate);
            }
            if (matches.Count == 1) { actualApp = app; contentPid = matches[0]; }
        }
        if (!string.Equals(app, actualApp, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Window application identity differs: {actualApp}");
        var op = Text(request, "operation");
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
        var selector = request.GetProperty("selector");
        var targets = nodes.Where(n => Matches(n, selector) && (!selector.TryGetProperty("ancestor", out var a) || n.Ancestors.Any(i => Matches(nodes[i], a)))).ToArray();
        if (targets.Length != 1) throw new InvalidOperationException($"Semantic target count is {targets.Length}; expected one");
        var target = targets[0];
        if (!root.Current.IsEnabled || target.Disabled || !target.Element.Current.IsEnabled) throw new InvalidOperationException("Target or its window is disabled");
        if (target.Password || target.Element.Current.IsPassword) throw new InvalidOperationException("Password controls require the dedicated supported workflow");
        var expected = request.GetProperty("runtimeId").EnumerateArray().Select(e => e.GetInt32()).ToArray();
        if (!expected.SequenceEqual(target.RuntimeId)) throw new InvalidOperationException("Control identity changed; inspect again");
        string mechanism;
        if (op == "click")
        {
            if (target.Element.TryGetCurrentPattern(InvokePattern.Pattern, out var p)) { ((InvokePattern)p).Invoke(); mechanism = "Invoke"; }
            else if (target.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); mechanism = "Select"; }
            else if (target.Element.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); mechanism = "Toggle"; }
            else if (target.Role is "edit" or "document") { target.Element.SetFocus(); mechanism = "Focus"; }
            else throw new InvalidOperationException("No semantic click pattern; inspect a screenshot and use Sky coordinates");
        }
        else if (op == "setValue")
        {
            if (!target.Element.TryGetCurrentPattern(ValuePattern.Pattern, out var p) || ((ValuePattern)p).Current.IsReadOnly)
                throw new InvalidOperationException("No writable ValuePattern; focus and use Sky text input");
            ((ValuePattern)p).SetValue(Text(request, "value")); mechanism = "Value";
        }
        else if (op == "secondary")
        {
            var action = Text(request, "action");
            if (!target.Actions.Contains(action)) throw new InvalidOperationException("Secondary action is not exposed");
            var pattern = (ExpandCollapsePattern)target.Element.GetCurrentPattern(ExpandCollapsePattern.Pattern);
            if (action == "Expand") pattern.Expand(); else pattern.Collapse();
            mechanism = action;
        }
        else throw new InvalidOperationException("Unknown native operation");
        return new { ok = true, mechanism };
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
