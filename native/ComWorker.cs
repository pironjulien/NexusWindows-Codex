using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

// Processus enfant « COM pur » (--com-worker) : motifs UI Automation avec AutoSetFocus = FALSE, sans jamais charger
// System.Windows.Automation (voir Background.cs). Une requete JSON par ligne, une reponse par ligne. Il vit tant que
// le helper parent garde son entree standard ouverte (mort du parent = fin de l'enfant).
static class ComWorker
{
    const string Uia = "background:uia";

    public static int Run()
    {
        EmergencyStop.Watch();
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            object result;
            try
            {
                using var json = JsonDocument.Parse(line);
                result = Execute(json.RootElement);
            }
            catch (Exception error) { result = new { ok = false, error = error.GetType().Name, message = error.Message }; }
            Console.WriteLine(JsonSerializer.Serialize(result));
            Console.Out.Flush();
        }
        return 0;
    }

    static object Execute(JsonElement request)
    {
        EmergencyStop.ThrowIfStopped();
        var op = request.GetProperty("op").GetString();
        var window = (nint)request.GetProperty("windowId").GetInt64();
        var runtimeId = request.GetProperty("runtimeId").EnumerateArray().Select(e => e.GetInt32()).ToArray();
        string Text(string key) => request.TryGetProperty(key, out var v) ? v.GetString() ?? "" : "";
        // Avant le motif, tout echec (fenetre ou element disparus, fournisseur absent) precede l'entree.
        nint element;
        try { element = ComUia.Shared.FindByRuntimeId(window, runtimeId); }
        catch (Exception error) when (error is not (BackgroundNotApplicableException or EmergencyStopException))
        {
            throw new BackgroundNotApplicableException("UI Automation element unavailable before input: " + error.Message);
        }
        try
        {
            var outcome = op switch
            {
                "click" => Click(element, request.GetProperty("order").EnumerateArray().Select(e => e.GetString() ?? "").ToArray()),
                "setValue" => SetValue(element, Text("value")),
                "expandCollapse" => ExpandCollapse(element, Text("action")),
                "select" => WithPattern(element, ComUia.SelectionItemPatternId, Select, () => throw new BackgroundNotApplicableException("Option is not selectable")),
                "expandSelect" => ExpandSelect(element, Text("option")),
                _ => throw new InvalidOperationException("Unknown COM worker operation"),
            };
            return new { ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect };
        }
        finally { ComUia.Release(element); }
    }

    static T WithPattern<T>(nint element, int patternId, Func<nint, T> action, Func<T> missing)
    {
        var pattern = ComUia.Pattern(element, patternId);
        if (pattern == 0) return missing();
        try { return action(pattern); } finally { ComUia.Release(pattern); }
    }
    static Outcome Toggle(nint pattern)
    {
        var before = ComUia.ReadInt(pattern, 4);
        EmergencyStop.ThrowIfStopped();
        ComUia.CallSlot(pattern, 3);
        return new(Uia, "Toggle", ComUia.ReadInt(pattern, 4) != before ? "applied" : "none");
    }
    static Outcome Select(nint pattern)
    {
        EmergencyStop.ThrowIfStopped();
        ComUia.CallSlot(pattern, 3);
        return new(Uia, "SelectionItem.Select", ComUia.ReadInt(pattern, 6) != 0 ? "applied" : "none");
    }
    static Outcome Click(nint element, string[] order)
    {
        foreach (var name in order)
        {
            Outcome? outcome = name switch
            {
                "toggle" => WithPattern<Outcome?>(element, ComUia.TogglePatternId, p => Toggle(p), () => null),
                "invoke" => WithPattern<Outcome?>(element, ComUia.InvokePatternId, p => { EmergencyStop.ThrowIfStopped(); ComUia.CallSlot(p, 3); return new(Uia, "Invoke", "sent"); }, () => null),
                "select" => WithPattern<Outcome?>(element, ComUia.SelectionItemPatternId, p => Select(p), () => null),
                _ => null,
            };
            if (outcome is { } done) return done;
        }
        throw new BackgroundNotApplicableException("No background click pattern (Invoke, Toggle or SelectionItem) for this control");
    }
    static Outcome SetValue(nint element, string value) => WithPattern(element, ComUia.ValuePatternId, pattern =>
    {
        if (ComUia.ReadInt(pattern, 5) != 0) throw new BackgroundNotApplicableException("Read-only value");
        var before = ComUia.Value(pattern);
        EmergencyStop.ThrowIfStopped();
        ComUia.SetValue(pattern, value);
        var after = ComUia.Value(pattern);
        return new Outcome(Uia, "Value.SetValue", after == value ? "applied" : after == before ? "none" : "sent");
    }, () => throw new BackgroundNotApplicableException("No writable ValuePattern"));
    static Outcome ExpandCollapse(nint element, string action) => WithPattern(element, ComUia.ExpandCollapsePatternId, pattern =>
    {
        EmergencyStop.ThrowIfStopped();
        ComUia.CallSlot(pattern, action == "Expand" ? 3 : 4);
        var state = ComUia.ReadInt(pattern, 5); // 0 replie, 1 deplie, 2 partiel, 3 feuille
        return new Outcome(Uia, action, (action == "Expand" ? state is 1 or 2 : state == 0) ? "applied" : "none");
    }, () => throw new BackgroundNotApplicableException("No ExpandCollapsePattern"));
    static Outcome ExpandSelect(nint element, string option)
    {
        var expand = ComUia.Pattern(element, ComUia.ExpandCollapsePatternId);
        if (expand == 0) throw new BackgroundNotApplicableException("Option is absent from the list");
        try
        {
            EmergencyStop.ThrowIfStopped();
            var wasCollapsed = ComUia.ReadInt(expand, 5) == 0;
            if (wasCollapsed) ComUia.CallSlot(expand, 3);
            try
            {
                var item = ComUia.Shared.FindByName(element, option);
                if (item == 0) throw new InvalidOperationException("Option did not appear after expanding the list; outcome unknown");
                try { return WithPattern(item, ComUia.SelectionItemPatternId, Select, () => throw new InvalidOperationException("Option is not selectable; outcome unknown")) with { Mechanism = "ExpandCollapse+SelectionItem.Select" }; }
                finally { ComUia.Release(item); }
            }
            finally { if (wasCollapsed && ComUia.ReadInt(expand, 5) != 0) ComUia.CallSlot(expand, 4); }
        }
        finally { ComUia.Release(expand); }
    }
}

// Cote helper gere : un enfant --com-worker reutilise, une requete a la fois, delai borne.
static class ComBridge
{
    static Process? child;
    const int TimeoutMs = 10000;

    public static Outcome Call(object request)
    {
        var process = child is { HasExited: false } ? child : Start();
        string? line;
        try
        {
            process.StandardInput.WriteLine(JsonSerializer.Serialize(request));
            process.StandardInput.Flush();
            var read = process.StandardOutput.ReadLineAsync();
            if (!read.Wait(TimeoutMs)) { Stop(); throw new InvalidOperationException("COM UI Automation worker timed out; outcome unknown"); }
            line = read.Result;
        }
        catch (IOException error) { Stop(); throw new InvalidOperationException("COM UI Automation worker lost; outcome unknown: " + error.Message); }
        if (line == null) { Stop(); throw new InvalidOperationException("COM UI Automation worker exited; outcome unknown"); }
        using var json = JsonDocument.Parse(line);
        var reply = json.RootElement;
        string Text(string key) => reply.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        if (reply.GetProperty("ok").GetBoolean()) return new(Text("technique"), Text("mechanism"), Text("effect"));
        var message = Text("message");
        throw Text("error") switch
        {
            nameof(BackgroundNotApplicableException) => new BackgroundNotApplicableException(message),
            nameof(ActionRefusedException) => new ActionRefusedException(message),
            nameof(EmergencyStopException) => new EmergencyStopException(message),
            _ => new InvalidOperationException(message + " (outcome unknown)"),
        };
    }

    static Process Start()
    {
        Stop();
        var start = new ProcessStartInfo(Environment.ProcessPath ?? throw new InvalidOperationException("Helper path unavailable"), "--com-worker")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = new UTF8Encoding(false), StandardInputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
        };
        child = Process.Start(start) ?? throw new BackgroundNotApplicableException("COM UI Automation worker did not start");
        child.ErrorDataReceived += (_, _) => { }; // vide stderr sans le garder
        child.BeginErrorReadLine();
        return child;
    }
    static void Stop()
    {
        var current = child; child = null;
        try { if (current is { HasExited: false }) current.Kill(); } catch (InvalidOperationException) { }
        current?.Dispose();
    }
}
