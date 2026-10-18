using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

// Shared emergency stop (shared protocol emergency-stop.md). A NEW version of `stop` (write time + content)
// younger than HoldSeconds freezes every desktop action of this process for the remaining time. The stop is latched
// in memory on a monotonic clock: deleting the file or moving the wall clock never lifts it; only time does.
sealed class EmergencyStopException(string message) : InvalidOperationException(message);

static class EmergencyStop
{
    public const double HoldSeconds = 120;
    const int HeartbeatMs = 3000, WatchMs = 200;
    const string HotkeyLabel = "Ctrl+Alt+Maj+Échap";
    static readonly object Gate = new();
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static double latchedUntil; // Clock seconds; never moves backwards.
    static string? seen;
    static Timer? watcher;

    // NEXUS_SHARED_HOME is for tests only: they must never write the real %USERPROFILE%\.nexus\stop.
    public static bool TestDirectory => !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NEXUS_SHARED_HOME"));
    public static string Directory => TestDirectory
        ? Environment.GetEnvironmentVariable("NEXUS_SHARED_HOME")!
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nexus");
    static string StopFile => Path.Combine(Directory, "stop");
    static string OwnerFile => Path.Combine(Directory, "stop.owner");

    static void Latch(double seconds)
    {
        lock (Gate) latchedUntil = Math.Max(latchedUntil, Clock.Elapsed.TotalSeconds + seconds);
    }

    public static double RemainingSeconds()
    {
        try
        {
            var info = new FileInfo(StopFile);
            if (info.Exists)
            {
                var write = info.LastWriteTimeUtc;
                var version = write.Ticks + ":" + Convert.ToBase64String(SHA256.HashData(File.ReadAllBytes(StopFile)));
                bool fresh;
                lock (Gate) { fresh = version != seen; seen = version; }
                if (fresh)
                {
                    var left = Math.Clamp(HoldSeconds - (DateTime.UtcNow - write).TotalSeconds, 0, HoldSeconds);
                    if (left > 0) Latch(left);
                }
            }
        }
        catch (IOException) { } // Missing or unreadable: the latch already set still holds.
        catch (UnauthorizedAccessException) { }
        lock (Gate) return Math.Max(latchedUntil - Clock.Elapsed.TotalSeconds, 0);
    }

    public static string Message(double remaining) =>
        $"Arrêt d'urgence demandé par Julien ({HotkeyLabel}) : plus aucune action pendant encore {Math.Ceiling(remaining)} s ; ne pas contourner. " +
        "Attendre ses instructions dans la conversation ; une action refusée ainsi ne doit jamais être rejouée.";

    // Checkpoint before every desktop action (input, foreground, UIA pattern). Observations never call it.
    public static void ThrowIfStopped()
    {
        var left = RemainingSeconds();
        if (left > 0) throw new EmergencyStopException(Message(left));
    }

    // Long-lived processes re-read the file even while idle, so a deletion between two requests cannot lift it.
    public static void Watch()
    {
        RemainingSeconds();
        watcher ??= new Timer(_ => { try { RemainingSeconds(); } catch { } }, null, WatchMs, WatchMs);
    }

    // ---- Hotkey guard (--stop-guard): lives as long as its client keeps stdin open. ----
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] static extern int GetMessageW(out Msg msg, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern nuint SetTimer(nint hwnd, nuint id, uint ms, nint callback);
    [StructLayout(LayoutKind.Sequential)] struct Msg { public nint Hwnd; public uint Message; public nuint WParam; public nint LParam; public uint Time; public int X, Y; }
    const uint ModAlt = 0x1, ModControl = 0x2, ModShift = 0x4, ModNoRepeat = 0x4000, VkEscape = 0x1B, WmHotkey = 0x312, WmTimer = 0x113;
    const int HotkeyId = 0x4E58; // "NX"
    static readonly object Output = new();

    internal static void Emit(object value)
    {
        lock (Output) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    }

    public static int Guard(string version)
    {
        Watch();
        // Presence de Julien (Raw Input, lecture seule) : meme processus long, independant du raccourci.
        Presence.Start(Emit);
        var thread = new Thread(() => HotkeyLoop(version)) { IsBackground = true, Name = "nexus-stop-hotkey" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        // EOF (client closed or died) ends the guard. "press" simulates the hotkey for tests in a test directory.
        string? line;
        while ((line = Console.ReadLine()) != null)
            if (line.Trim() == "press" && TestDirectory) Pressed();
        return 0;
    }

    static void HotkeyLoop(string version)
    {
        if (TestDirectory)
        {
            // A guard pointed at a test directory must not take the real hotkey from the other agents.
            Emit(new { @event = "hotkey", state = "disabled" });
            return;
        }
        var reported = false;
        while (!RegisterHotKey(0, HotkeyId, ModControl | ModAlt | ModShift | ModNoRepeat, VkEscape))
        {
            if (!reported) { Emit(new { @event = "hotkey", state = "retrying", error = Marshal.GetLastWin32Error() }); reported = true; }
            Thread.Sleep(HeartbeatMs); // Held by another agent: take over when it stops.
        }
        Emit(new { @event = "hotkey", state = "owned" });
        Heartbeat(version);
        SetTimer(0, 0, HeartbeatMs, 0);
        while (GetMessageW(out var msg, 0, 0, 0) > 0)
        {
            if (msg.Message == WmHotkey && msg.WParam == HotkeyId) Pressed();
            else if (msg.Message == WmTimer) Heartbeat(version);
        }
    }

    static void Heartbeat(string version)
    {
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            File.WriteAllText(OwnerFile, JsonSerializer.Serialize(new { owner = "NexusCodex", pid = Environment.ProcessId, version, ts = Now() }));
        }
        catch (IOException) { } // A missed beat makes the others report the stop as unavailable, which stays honest.
        catch (UnauthorizedAccessException) { }
    }

    // Latch locally BEFORE writing the file (which warns the other agents), then tell the client on stdout.
    static void Pressed()
    {
        Latch(HoldSeconds);
        string? failure = null;
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            File.WriteAllText(StopFile, JsonSerializer.Serialize(new
            {
                by = "NexusCodex", pid = Environment.ProcessId, at = Now(), hold_s = HoldSeconds,
                nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
            }));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { failure = error.Message; }
        // The client latches on this line even when the file could not be written.
        Emit(new { @event = "stop", hold_s = HoldSeconds, written = failure == null, error = failure });
    }

    static double Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
}
