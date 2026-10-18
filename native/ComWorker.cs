using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
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
        var hint = request.TryGetProperty("nativeWindow", out var h) && h.ValueKind == JsonValueKind.Number ? (nint)h.GetInt64() : 0;
        try { element = ComUia.Shared.FindByRuntimeId(window, runtimeId, hint); }
        catch (Exception error) when (error is not (BackgroundNotApplicableException or EmergencyStopException))
        {
            throw new BackgroundNotApplicableException("UI Automation element unavailable before input: " + error.Message);
        }
        try
        {
            var outcome = op switch
            {
                "click" => Click(element, request.GetProperty("order").EnumerateArray().Select(e => e.GetString() ?? "").ToArray()),
                "invoke" => WithPattern(element, ComUia.InvokePatternId, p => { EmergencyStop.ThrowIfStopped(); ComUia.CallSlot(p, 3); return new Outcome(Uia, "Invoke", "sent"); },
                    () => throw new BackgroundNotApplicableException("No InvokePattern")),
                "setFocus" => SetFocus(element),
                "setValue" => SetValue(element, Text("value")),
                "expandCollapse" => ExpandCollapse(element, Text("action")),
                "selectItem" => SelectItem(window, element, request.GetProperty("containerRuntimeId").EnumerateArray().Select(e => e.GetInt32()).ToArray()),
                "selectOption" => SelectOption(element, Text("option"), request.TryGetProperty("combo", out var c) && c.GetBoolean()),
                _ => throw new InvalidOperationException("Unknown COM worker operation"),
            };
            return new { ok = true, technique = outcome.Technique, mechanism = outcome.Mechanism, effect = outcome.Effect };
        }
        finally { ComUia.Release(element); }
    }
    static Outcome SetFocus(nint element)
    {
        EmergencyStop.ThrowIfStopped();
        ComUia.SetFocus(element);
        return new("foreground:uia", "SetFocus", ComUia.HasKeyboardFocus(element) ? "applied" : "sent");
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
    // Etat relu par le motif ExpandCollapse (0 replie, 1 deplie, 2 partiel, 3 feuille), attendu au plus 0,5 s : certains
    // fournisseurs (WPF) ouvrent leur surgissante de facon asynchrone.
    static int WaitState(nint pattern, Func<int, bool> reached)
    {
        var state = ComUia.ReadInt(pattern, 5);
        for (var i = 0; i < 10 && !reached(state); i++) { Thread.Sleep(50); state = ComUia.ReadInt(pattern, 5); }
        return state;
    }
    static Outcome ExpandCollapse(nint element, string action) => WithPattern(element, ComUia.ExpandCollapsePatternId, pattern =>
    {
        var before = ComUia.ReadInt(pattern, 5);
        EmergencyStop.ThrowIfStopped();
        ComUia.CallSlot(pattern, action == "Expand" ? 3 : 4);
        Func<int, bool> reached = action == "Expand" ? s => s is 1 or 2 : s => s == 0;
        var state = WaitState(pattern, reached);
        return new Outcome(Uia, action, reached(state) ? "applied" : state == before ? "none" : "sent");
    }, () => throw new BackgroundNotApplicableException("No ExpandCollapsePattern"));

    // Option d'une liste deroulante (conteneur) choisie par SelectionItem, puis la liste refermee : une liste laissee
    // ouverte est une surgissante au-dessus des fenetres de Julien (un clic de sa part y choisirait une option).
    static Outcome SelectItem(nint window, nint item, int[] containerRuntimeId)
    {
        var container = ComUia.Shared.FindByRuntimeId(window, containerRuntimeId);
        try
        {
            var selected = WithPattern(item, ComUia.SelectionItemPatternId, Select, () => throw new BackgroundNotApplicableException("Option is not selectable"));
            return Close(container, selected with { Mechanism = "SelectionItem.Select" });
        }
        finally { ComUia.Release(container); }
    }
    // Liste ou liste deroulante UIA (WPF, XAML, Chromium) : option deja publiee sous le conteneur, sinon depliage sans
    // focus, choix par SelectionItem, puis repliage (toujours pour une liste deroulante, sinon si elle etait repliee).
    // Correspondance des options : egalite exacte unique, puis sans casse unique ; jamais partielle.
    static Outcome SelectOption(nint container, string option, bool combo)
    {
        var expand = ComUia.Pattern(container, ComUia.ExpandCollapsePatternId);
        try
        {
            var item = FindOption(container, option, allowAbsent: expand != 0);
            var opened = false;
            if (item == 0)
            {
                EmergencyStop.ThrowIfStopped();
                if (ComUia.ReadInt(expand, 5) != 0) throw new BackgroundNotApplicableException("Option is absent from the list");
                ComUia.CallSlot(expand, 3);
                opened = true;
                for (var i = 0; i < 10 && item == 0; i++)
                {
                    item = FindOption(container, option, allowAbsent: true);
                    if (item == 0) Thread.Sleep(50);
                }
                if (item == 0)
                {
                    Close(container, new Outcome(Uia, "ExpandCollapse", "sent"));
                    throw new InvalidOperationException("Option did not appear after expanding the list (list collapsed again); outcome unknown");
                }
            }
            try
            {
                Outcome selected;
                try { selected = WithPattern(item, ComUia.SelectionItemPatternId, Select, () => throw new InvalidOperationException("Option is not selectable; outcome unknown")); }
                catch (BackgroundNotApplicableException error) when (opened) { throw new InvalidOperationException(error.Message + " (list was expanded; outcome unknown)"); }
                selected = selected with { Mechanism = (opened ? "ExpandCollapse+" : "") + "SelectionItem.Select" };
                return combo || opened ? Close(container, selected) : selected;
            }
            finally { ComUia.Release(item); }
        }
        finally { ComUia.Release(expand); }
    }
    static nint FindOption(nint container, string option, bool allowAbsent)
    {
        var items = ComUia.Shared.SelectableItems(container);
        try
        {
            int index;
            try { index = Program.MatchOption(items.Select(i => (string?)i.Name).ToList(), option); }
            catch (BackgroundNotApplicableException error) when (error.Message.Contains("absent") && allowAbsent) { return 0; }
            var found = items[index].Element;
            items[index] = (0, "");
            return found;
        }
        finally { foreach (var (element, _) in items) ComUia.Release(element); }
    }
    // Repliage relu apres le choix ; le choix deja fait n'est jamais rejoue. Liste restee ouverte : effet « sent ».
    static Outcome Close(nint container, Outcome selected)
    {
        var expand = ComUia.Pattern(container, ComUia.ExpandCollapsePatternId);
        if (expand == 0) return selected;
        try
        {
            // Certaines listes se referment d'elles-memes apres le choix : un Collapse tardif peut alors echouer.
            if (ComUia.ReadInt(expand, 5) is 1 or 2)
            {
                try { ComUia.CallSlot(expand, 4); } catch (System.Runtime.InteropServices.COMException) { }
            }
            var closed = WaitState(expand, s => s == 0) == 0;
            return selected with { Mechanism = selected.Mechanism + "+Collapse", Effect = closed ? selected.Effect : "sent" };
        }
        finally { ComUia.Release(expand); }
    }
}

// Cote helper gere : un enfant --com-worker reutilise, une requete a la fois, delai borne. L'enfant est rattache a un
// Job Object (KILL_ON_JOB_CLOSE) : si le helper meurt (delai depasse cote Node, qui le tue), Windows tue aussi l'enfant,
// qui ne peut donc plus agir apres coup sur une action deja rapportee « inconnue ».
static class ComBridge
{
    static Process? child;
    public const int TimeoutMs = 10000; // lib/native.mjs (COM_ACTION_MS) le depasse toujours
    static nint job;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern nint CreateJobObjectW(nint attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(nint job, int infoClass, ref ExtendedLimit info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(nint job, nint process);
    const int JobObjectExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    // Job du processus helper, cree une fois ; son handle n'est jamais ferme avant la fin du helper (fermeture = mort des
    // enfants).
    static nint Job()
    {
        if (job != 0) return job;
        var created = CreateJobObjectW(0, null);
        if (created == 0) throw new BackgroundNotApplicableException($"Job Object unavailable (error {Marshal.GetLastWin32Error()}); COM worker not started");
        var info = new ExtendedLimit { Basic = new BasicLimit { LimitFlags = KillOnJobClose } };
        if (!SetInformationJobObject(created, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf<ExtendedLimit>()))
            throw new BackgroundNotApplicableException($"Job Object limit refused (error {Marshal.GetLastWin32Error()}); COM worker not started");
        return job = created;
    }

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
        var jobHandle = Job();
        child = Process.Start(start) ?? throw new BackgroundNotApplicableException("COM UI Automation worker did not start");
        // Avant toute requete : un enfant qui ne serait pas lie au helper pourrait lui survivre. Rien n'a ete envoye.
        if (!AssignProcessToJobObject(jobHandle, child.Handle))
        {
            var error = Marshal.GetLastWin32Error();
            Stop();
            throw new BackgroundNotApplicableException($"COM worker could not be bound to the helper (Job Object, error {error}); nothing was sent");
        }
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
