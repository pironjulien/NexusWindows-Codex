using System.Diagnostics;
using System.IO;
using System.Text.Json;

// The handle is the authority; diagnostics are never used to break a lock.
sealed class ForegroundToken : IDisposable
{
    const long Offset = 1L << 32;
    public const int WaitMs = 8000; // attente maximale du jeton ; lib/native.mjs (TOKEN_WAIT_MS) la depasse toujours
    readonly FileStream stream;
    ForegroundToken(FileStream stream) => this.stream = stream;

    public static ForegroundToken Acquire(string purpose, Task? abandoned = null)
    {
        EmergencyStop.ThrowIfStopped();
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nexus", "foreground.lock");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
        var timer = Stopwatch.StartNew();
        try
        {
            while (true)
            {
                if (abandoned?.IsCompleted == true) throw new OperationCanceledException("Foreground request abandoned");
                try { stream.Lock(Offset, 1); break; }
                catch (IOException)
                {
                    // Attente interruptible (shared/foreground-token.md, comme `abort` de shared/foreground_lock.py) :
                    // l'arret d'urgence est relu a chaque tour de 50 ms, jamais seulement apres les 8 s.
                    EmergencyStop.ThrowIfStopped();
                    if (timer.ElapsedMilliseconds >= WaitMs)
                    {
                        stream.Position = 0;
                        var bytes = new byte[4096];
                        var count = stream.Read(bytes, 0, bytes.Length);
                        throw new TimeoutException("Foreground token unavailable; action deferred. Holder: " + System.Text.Encoding.UTF8.GetString(bytes, 0, count));
                    }
                    Thread.Sleep(50);
                }
            }
        }
        catch { stream.Dispose(); throw; }
        // The wait can last up to eight seconds: a stop requested meanwhile refuses the action before any input.
        try { EmergencyStop.ThrowIfStopped(); } catch { stream.Unlock(Offset, 1); stream.Dispose(); throw; }
        var token = new ForegroundToken(stream);
        try
        {
            var data = JsonSerializer.SerializeToUtf8Bytes(new { owner = "NexusCodex", pid = Environment.ProcessId, since = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), purpose });
            stream.SetLength(0);
            stream.Write(data);
            stream.Flush();
            return token;
        }
        catch { token.Dispose(); throw; }
    }

    public void Dispose()
    {
        try { stream.SetLength(0); stream.Flush(); }
        finally { try { stream.Unlock(Offset, 1); } finally { stream.Dispose(); } }
    }
}

// Julien a-t-il repris clavier ou souris pendant l'attente du jeton ? GetLastInputInfo compte toute entree (injectee
// comprise) : prudent, une entree d'un autre agent differe aussi. Aucune entree n'a encore ete envoyee ici.
sealed class JulienActiveException(string message) : InvalidOperationException(message);
static class JulienPause
{
    public static void ThrowIfActive(int? quietMs)
    {
        if (quietMs is not { } quiet || quiet <= 0) return;
        var info = new Win32.LastInputInfo { Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf<Win32.LastInputInfo>() };
        if (!Win32.GetLastInputInfo(ref info)) throw new JulienActiveException("Presence de Julien illisible apres la prise du jeton : entree differee, rien n'a ete envoye.");
        var idle = unchecked(Win32.GetTickCount() - info.Time);
        if (idle < quiet)
            throw new JulienActiveException($"Julien utilise le clavier ou la souris (derniere entree il y a {idle} ms, apres l'attente du jeton) : entree differee, rien n'a ete envoye. Reobserver plus tard ; ne jamais rejouer automatiquement.");
    }
}

// Premier plan rendu a Julien SOUS le jeton, avant de rendre le jeton (shared/foreground-token.md) : la fenetre active
// notee a la prise du jeton est remise devant, seulement si la fenetre cible (son processus) tient encore le premier
// plan. Si Julien est passe a une autre fenetre, rien ne lui est repris. Etats : restored, not-taken (la cible n'a pas
// le premier plan, ou Julien etait deja dans la cible), kept-by-julien, none (aucune fenetre a qui le rendre), refused.
static class ForegroundReturn
{
    static readonly HashSet<string> Switchers = new(StringComparer.OrdinalIgnoreCase) { "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow", "MultitaskingViewFrame", "TaskSwitcherWnd", "ForegroundStaging" };

    // `input` : LastInput note avec la fenetre ; relu avant chaque geste de restitution et pendant chaque attente. Julien
    // (ou un pair) a touche clavier ou souris entre-temps : son choix est garde, rien n'est remis devant (relecture de
    // Codex, 21/10 : la seconde tentative pouvait tomber au milieu de sa saisie).
    public static string GiveBack(nint noted, nint target, uint? input = null)
    {
        // Sans reference donnee (repli UIA, bail physique) : saisie notee a l'entree, ce qui couvre la restitution elle-meme
        // sans confondre les entrees precedentes de l'agent avec Julien (relecture de Codex, 21/10).
        input ??= Win32.Probe().LastInput;
        bool Moved() => Win32.Probe().LastInput != input;
        if (target == 0 || noted == 0) return "none";
        if (Moved()) return "kept-by-julien";
        var fg = Win32.GetForegroundWindow();
        if (fg == noted) return "not-taken";
        var targetPid = Win32.ProcessOf(target);
        if (Win32.ProcessOf(noted) == targetPid) return "not-taken"; // Julien etait deja dans l'application cible
        if (fg == 0) return "not-taken";
        if (Win32.ProcessOf(fg) != targetPid) return "kept-by-julien";
        if (!Restorable(noted)) return "none";
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (Win32.GetForegroundWindow() != fg) break; // le premier plan a change entre-temps : ne rien forcer
            if (Moved()) return "kept-by-julien";
            var own = Win32.GetCurrentThreadId();
            var thread = Win32.GetWindowThreadProcessId(fg, out _);
            var attached = thread != 0 && thread != own && Win32.AttachThreadInput(own, thread, true);
            try
            {
                if (Win32.GetForegroundWindow() == fg) { Win32.BringWindowToTop(noted); Win32.SetForegroundWindow(noted); }
            }
            finally { if (attached) Win32.AttachThreadInput(own, thread, false); }
            if (Wait(noted, 150, Moved)) return "restored";
            if (Moved()) return "kept-by-julien";
        }
        // Plus de repli par WM_SYSCOMMAND SC_HOTKEY POSTE : une attente expiree ne retire pas le message de la file, qui
        // pouvait reactiver l'ancienne fenetre apres le jeton et apres un choix de Julien (relecture de Codex, 21/10).
        return Win32.GetForegroundWindow() is var now && now != 0 && Win32.ProcessOf(now) != targetPid && now != noted ? "kept-by-julien" : "refused";
    }
    static bool Wait(nint window, int ms, Func<bool>? stop = null)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < ms)
        {
            if (Win32.GetForegroundWindow() == window) return true;
            if (stop?.Invoke() == true) return false;
            Thread.Sleep(10);
        }
        return Win32.GetForegroundWindow() == window;
    }
    static bool Restorable(nint hwnd) =>
        Win32.IsWindow(hwnd) && Win32.IsWindowVisible(hwnd) && !Win32.IsIconic(hwnd) && !Win32.IsCloaked(hwnd) && !Switchers.Contains(Win32.ClassName(hwnd));
}
