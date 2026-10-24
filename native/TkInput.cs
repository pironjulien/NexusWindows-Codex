using System.Runtime.InteropServices;

// Tk en arriere-plan (recette de NexusClaude du 23/10, relue par Codex en six tours ; portee dans NexusAGY 3.0.2, relue
// en cinq tours). Tk lit l'etat des boutons par GetKeyState au traitement du message (TkWinGetModifierState) : un clic
// poste sans bouton « enfonce » est ignore. Pression ENVOYEE avec le bouton simule pour le seul fil de Tk, par un fil
// auxiliaire qui possede pression ET relachement (le delai de SendMessageTimeout n'est pas garanti sous AttachThreadInput) ;
// une pression simulee a la fois par fil ; relachement sans reponse : fil ferme aux pressions simulees tant que la
// fenetre existe. Molette : Tk la renvoie a la fenetre sous le point (WindowFromPoint), perdue si elle est recouverte ;
// une liste defile par sa barre native (tk.Scrollbar) COLLEE au widget vise, position relue (GetScrollInfo).
static class TkInput
{
    [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern nint SendMessageTimeoutW(nint hwnd, uint msg, nint wparam, nint lparam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll")] static extern bool GetScrollInfo(nint hwnd, int bar, ref ScrollInfo info);
    [DllImport("user32.dll")] static extern bool GetWindowRect(nint hwnd, out Win32.Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint hwnd, char[] name, int max);
    [StructLayout(LayoutKind.Sequential)] struct ScrollInfo { public uint Size, Mask; public int Min, Max; public uint Page; public int Pos, TrackPos; }

    const uint WM_MOUSEMOVE = 0x0200, WM_VSCROLL = 0x0115, WM_HSCROLL = 0x0114;
    const int SB_LINEUP = 0, SB_LINEDOWN = 1, SB_ENDSCROLL = 8, SB_CTL = 2, SBS_VERT = 1, LinesPerNotch = 3;
    static readonly HashSet<uint> Pending = [];
    static readonly object Gate = new();
    static readonly Dictionary<string, (uint Down, uint Up, int Mk, uint Dbl, int Vk)> Buttons = new()
    {
        ["left"] = (0x0201, 0x0202, 0x0001, 0x0203, 0x01),
        ["right"] = (0x0204, 0x0205, 0x0002, 0x0206, 0x02),
        ["middle"] = (0x0207, 0x0208, 0x0010, 0x0209, 0x04),
    };

    static string ClassOf(nint hwnd) { var b = new char[256]; var n = GetClassNameW(hwnd, b, b.Length); return new string(b, 0, Math.Max(0, n)); }
    static uint ThreadOf(nint hwnd) => Win32.GetWindowThreadProcessId(hwnd, out _);
    static bool InFront(uint thread) { var fg = Win32.GetForegroundWindow(); return fg != 0 && ThreadOf(fg) == thread; }
    static bool Send(nint hwnd, uint msg, nint wparam, nint lparam) => SendMessageTimeoutW(hwnd, msg, wparam, lparam, 0x0002 /* ABORTIFHUNG */, 1000, out _) != 0;

    // Touche `vk` « enfoncee » pour le seul fil de `target` ; en sortie, elle seule reprend sa valeur d'avant (son etat
    // physique si l'utilisateur a pris la fenetre) ; lecture impossible : l'etat d'avant entier.
    sealed class SimulatedKey : IDisposable
    {
        readonly uint own = Win32.GetCurrentThreadId(), thread;
        readonly int vk;
        readonly byte[] saved = new byte[256];
        bool attached;
        public SimulatedKey(nint target, int vk)
        {
            this.vk = vk;
            thread = ThreadOf(target);
            if (thread == 0 || InFront(thread)) throw new BackgroundNotApplicableException("The Tk window is in the foreground: nothing simulated");
            if (!Win32.AttachThreadInput(own, thread, true)) throw new BackgroundNotApplicableException("AttachThreadInput refused");
            attached = true;
            GetKeyboardState(saved);
            var state = (byte[])saved.Clone();
            state[vk] = 0x80;
            SetKeyboardState(state);
        }
        public void Dispose()
        {
            if (!attached) return;
            try
            {
                var now = new byte[256];
                if (!GetKeyboardState(now)) Array.Copy(saved, now, 256);
                now[vk] = InFront(thread) ? (byte)(((GetAsyncKeyState(vk) & 0x8000) != 0 ? 0x80 : 0) | (saved[vk] & 1)) : saved[vk];
                SetKeyboardState(now);
            }
            finally { Win32.AttachThreadInput(own, thread, false); attached = false; }
        }
    }

    static void HeldPress(nint target, int vk, uint down, uint up, int mk, nint lp)
    {
        var thread = ThreadOf(target);
        lock (Gate) if (!Pending.Add(thread)) throw new ActionRefusedException("A previous simulated press in this application is not finished");
        var sync = new object();
        var abandoned = false; // sous `sync` : l'abandon et la decision de presser s'excluent (relecture de Codex du 24/10)
        var done = new ManualResetEventSlim();
        Exception? error = null;
        var worker = new Thread(() =>
        {
            var pressed = false;
            try
            {
                lock (sync) if (abandoned) return;
                using (new SimulatedKey(target, vk))
                {
                    EmergencyStop.ThrowIfStopped(); // relu juste avant la pression
                    lock (sync)
                    {
                        if (abandoned) return; // le fil de travail a deja rendu : plus aucune pression
                        pressed = true;
                    }
                    if (!Send(target, down, mk, lp)) error ??= new InvalidOperationException("The press got no answer within 1 s; outcome unknown");
                }
            }
            catch (Exception e) { error ??= e; }
            finally
            {
                try
                {
                    if (pressed && !Send(target, up, 0, lp)) // relachement de nettoyage, etat deja restaure : toujours envoye
                    {
                        error ??= new InvalidOperationException("The release got no answer within 1 s; outcome unknown");
                        done.Set();
                        while (Win32.IsWindow(target)) Thread.Sleep(1000); // jamais prouve solde : fil ferme aux pressions simulees
                    }
                }
                finally { lock (Gate) Pending.Remove(thread); done.Set(); }
            }
        }) { IsBackground = true, Name = "nexus-held-press" };
        worker.Start();
        var deadline = Environment.TickCount64 + 1000;
        try
        {
            while (!done.Wait(20))
            {
                EmergencyStop.ThrowIfStopped(); // arret d'urgence : abandon, l'auxiliaire non parti n'envoie plus rien
                if (Environment.TickCount64 >= deadline) throw new InvalidOperationException("The press got no answer within 1 s; outcome unknown");
            }
        }
        catch { lock (sync) abandoned = true; throw; }
        if (error != null) throw error;
    }

    // Clic Tk : survol envoye puis, pour chaque pression, le bouton simule pour le seul fil de Tk. started() avant le
    // premier envoi : au-dela, toute erreur est une issue inconnue (jamais rejouee, jamais de vraie souris par-dessus).
    public static Outcome Click(nint target, nint lp, string button, int count, Action started)
    {
        if (!Buttons.TryGetValue(button, out var b)) throw new InvalidOperationException("Invalid mouse button");
        var thread = ThreadOf(target);
        if (InFront(thread)) throw new BackgroundNotApplicableException("The Tk window is in the foreground: nothing simulated");
        lock (Gate) if (Pending.Contains(thread)) throw new ActionRefusedException("A previous simulated press in this application is not finished");
        EmergencyStop.ThrowIfStopped();
        started();
        if (!Send(target, WM_MOUSEMOVE, 0, lp)) throw new InvalidOperationException("Tk did not answer the hover; outcome unknown");
        for (var i = 0; i < Math.Clamp(count, 1, 2); i++)
        {
            EmergencyStop.ThrowIfStopped();
            HeldPress(target, b.Vk, i == 1 ? b.Dbl : b.Down, b.Up, b.Mk, lp);
        }
        return new("background:messages", count == 2 ? "sent double click, button marked pressed for Tk's thread" : $"sent {button} click, button marked pressed for Tk's thread", "sent");
    }

    // Barre native visible du bon sens, soeur du widget sous le point, COLLEE a lui sur toute sa hauteur (largeur), et
    // collee a aucun autre widget frere ; exactement une, sinon 0 (rien devine).
    static nint BarBeside(nint under, bool vertical)
    {
        if (under == 0 || ClassOf(under).Equals("ScrollBar", StringComparison.OrdinalIgnoreCase)) return 0;
        var parent = Win32.GetParent(under);
        var siblings = new List<nint>();
        Win32.EnumChildWindows(parent, (h, _) => { if (Win32.GetParent(h) == parent && Win32.IsWindowVisible(h)) siblings.Add(h); return true; }, 0);
        GetWindowRect(under, out var box);
        bool Touches(Win32.Rect bar, Win32.Rect w, bool whole) => vertical
            ? (Math.Abs(bar.Left - w.Right) <= 4 || Math.Abs(w.Left - bar.Right) <= 4) &&
              (whole ? bar.Top <= w.Top + 4 && bar.Bottom >= w.Bottom - 4 : bar.Top < w.Bottom && w.Top < bar.Bottom)
            : (Math.Abs(bar.Top - w.Bottom) <= 4 || Math.Abs(w.Top - bar.Bottom) <= 4) &&
              (whole ? bar.Left <= w.Left + 4 && bar.Right >= w.Right - 4 : bar.Left < w.Right && w.Left < bar.Right);
        var found = new List<nint>();
        foreach (var bar in siblings)
        {
            if (!ClassOf(bar).Equals("ScrollBar", StringComparison.OrdinalIgnoreCase) || ((Win32.GetWindowLongW(bar, -16) & SBS_VERT) != 0) != vertical) continue;
            GetWindowRect(bar, out var r);
            if (!Touches(r, box, true)) continue;
            var shared = siblings.Any(h => h != bar && h != under && !ClassOf(h).Equals("ScrollBar", StringComparison.OrdinalIgnoreCase) &&
                GetWindowRect(h, out var o) && Touches(r, o, false));
            if (!shared) found.Add(bar);
        }
        return found.Count == 1 ? found[0] : 0;
    }

    static ScrollInfo? State(nint bar)
    {
        var info = new ScrollInfo { Size = (uint)Marshal.SizeOf<ScrollInfo>(), Mask = 0x1 | 0x2 | 0x4 };
        return GetScrollInfo(bar, SB_CTL, ref info) ? info : null;
    }

    // Defilement d'une liste Tk par sa barre native : un seul axe ; aucune barre, ou deja en butee : refus avant toute
    // entree ; lignes envoyees comme un clic sur la fleche, position relue 1 s au plus (« applied » si elle a bouge).
    public static Outcome Scroll(nint under, int deltaY, int deltaX, Action started)
    {
        if ((deltaY == 0) == (deltaX == 0)) throw new BackgroundNotApplicableException("Tk scroll bar: one axis at a time");
        var vertical = deltaY != 0;
        var forward = vertical ? deltaY < 0 : deltaX > 0; // deltaY negatif = vers le bas (WHEEL_DELTA)
        var bar = BarBeside(under, vertical);
        if (bar == 0) throw new BackgroundNotApplicableException("No native scroll bar drives what is under the point (Tk routes the wheel to the window on top)");
        var before = State(bar) ?? throw new BackgroundNotApplicableException("The scroll bar position cannot be read");
        var end = Math.Max(before.Min, before.Max - Math.Max((int)before.Page, 1) + 1);
        if (forward ? before.Pos >= end : before.Pos <= before.Min) throw new BackgroundNotApplicableException("The scroll bar is already at the " + (forward ? "end" : "start"));
        // Au plus 50 crans (150 lignes) par geste, comme NexusClaude : jamais des milliers de messages d'un coup.
        var lines = Math.Min(50, Math.Max(1, Math.Abs(vertical ? deltaY : deltaX) / 120)) * LinesPerNotch;
        var parent = Win32.GetParent(bar);
        var msg = vertical ? WM_VSCROLL : WM_HSCROLL;
        EmergencyStop.ThrowIfStopped();
        started();
        Exception? pending = null;
        try
        {
            for (var i = 0; i < lines; i++)
            {
                if (i > 0) EmergencyStop.ThrowIfStopped(); // arret d'urgence entre deux lignes : la suivante ne part pas
                Win32.Post(parent, msg, forward ? SB_LINEDOWN : SB_LINEUP, bar);
            }
        }
        catch (Exception error) { pending = error; }
        // Fin du defilement toujours signalee ; son echec ne masque jamais l'erreur en cours (arret d'urgence compris,
        // relecture de Codex du 24/10) : il n'est propage seul que si tout le reste a reussi.
        try { Win32.Post(parent, msg, SB_ENDSCROLL, bar); }
        catch (Exception cleanup) when (pending is not null) { System.Diagnostics.Trace.WriteLine("SB_ENDSCROLL: " + cleanup.Message); }
        if (pending is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(pending).Throw();
        var deadline = Environment.TickCount64 + 1000;
        while (Environment.TickCount64 < deadline)
        {
            Thread.Sleep(50);
            if (State(bar) is { } after && after.Pos != before.Pos)
                return new("background:messages", $"Tk scroll bar lines ({before.Pos} → {after.Pos})", "applied");
        }
        return new("background:messages", "Tk scroll bar lines (position not seen moving within 1 s)", "sent");
    }
}
