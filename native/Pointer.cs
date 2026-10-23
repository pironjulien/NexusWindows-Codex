using System.Runtime.InteropServices;

// Clic, double clic, clic droit et molette en arriere-plan a un point d'une capture NATIVE (banc commun des trois
// NexusWindows, 21/10/2026, plan de Codex etape 5) : messages postes a l'enfant le plus profond sous le point, premier
// plan et curseur intacts. Le cadre DWM releve a la capture est relu juste avant l'entree : fenetre deplacee ou
// redimensionnee = refus (observer de nouveau). Win32 et WinForms ; Chromium : clic poste, molette par DevTools si la
// cible a un port de debogage (Cdp.cs ; molette postee ignoree, mesure) ; WPF : molette par defilement semantique UI
// Automation (ComWorker scrollAt). UWP, Tk, et le reste de WPF : non applicable (souris postee ignoree).
static class Pointer
{
    [DllImport("user32.dll")] static extern nint ChildWindowFromPointEx(nint parent, Win32.Point point, uint flags);
    [DllImport("user32.dll")] static extern bool ScreenToClient(nint hwnd, ref Win32.Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint hwnd, char[] name, int max);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint hwnd, int attribute, out Win32.Rect rect, int size);
    [DllImport("user32.dll")] static extern nint WindowFromPoint(Win32.Point point);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo
    {
        public int Size, Flags;
        public nint Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Win32.Rect CaretRect;
    }

    // Trace du dernier clic poste (banc commun : double clic WinForms sans effet, plan de Codex du 22/10) : fenetre visee
    // (HWND, classe, fil), point client, messages postes, fenetre reellement sous le point (WinForms ne declenche Click et
    // DoubleClick que si WindowFromPoint du point du relachement est le controle lui-meme : Control.WmMouseUp) et etat du
    // fil apres l'envoi (capture, focus). La reception des messages postes n'est pas observable sans crochet dans le
    // processus cible : elle se deduit de cet etat, jamais affirmee.
    [ThreadStatic] public static object? LastTrace;

    const uint WM_MOUSEMOVE = 0x0200, WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E;
    static readonly Dictionary<string, (uint Down, uint Up, int Mk, uint Dbl)> Buttons = new()
    {
        ["left"] = (0x0201, 0x0202, 0x0001, 0x0203),
        ["right"] = (0x0204, 0x0205, 0x0002, 0x0206),
        ["middle"] = (0x0207, 0x0208, 0x0010, 0x0209),
    };

    static string ClassOf(nint hwnd) { var b = new char[256]; var n = GetClassNameW(hwnd, b, b.Length); return new string(b, 0, Math.Max(0, n)); }
    static nint Lparam(int x, int y) => (nint)(((y & 0xFFFF) << 16) | (x & 0xFFFF));

    static nint DeepestChild(nint top, int x, int y)
    {
        var current = top;
        for (var i = 0; i < 32; i++)
        {
            var p = new Win32.Point { X = x, Y = y };
            ScreenToClient(current, ref p);
            var child = ChildWindowFromPointEx(current, p, 0x0001 | 0x0002 | 0x0004); // CWP_SKIPINVISIBLE | SKIPDISABLED | SKIPTRANSPARENT
            if (child == 0 || child == current) break;
            current = child;
        }
        return current;
    }

    static object? ThreadState(uint thread)
    {
        var info = new GuiThreadInfo { Size = Marshal.SizeOf<GuiThreadInfo>() };
        return GetGUIThreadInfo(thread, ref info) ? new { capture = (long)info.Capture, focus = (long)info.Focus, active = (long)info.Active } : null;
    }

    public static Outcome Act(nint window, string action, int x, int y, int[] frame, string button, int count, int deltaY, int deltaX, Action started)
    {
        // Pixels reels de chaque ecran, comme la capture (Capture.cs) : point, cadre et repere client dans le meme espace.
        var previous = Win32.SetThreadDpiAwarenessContext(-4); // PER_MONITOR_AWARE_V2
        try { return ActPhysicalPixels(window, action, x, y, frame, button, count, deltaY, deltaX, started); }
        finally { if (previous != 0) Win32.SetThreadDpiAwarenessContext(previous); }
    }

    static Outcome ActPhysicalPixels(nint window, string action, int x, int y, int[] frame, string button, int count, int deltaY, int deltaX, Action started)
    {
        var cls = ClassOf(window);
        var chromium = cls.StartsWith("Chrome_WidgetWin_");
        var wpf = cls.StartsWith("HwndWrapper");
        var classic = !chromium && !wpf && cls != "ApplicationFrameWindow" && !cls.StartsWith("Windows.UI.") &&
            cls != "TkTopLevel" && !cls.StartsWith("Mozilla");
        if (!classic && !(chromium && action is "click" or "wheel") && !(wpf && action == "wheel"))
            throw new BackgroundNotApplicableException("This interface ignores posted mouse input (measured): no background technique");
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        if (Win32.IsIconic(window)) throw new ActionRefusedException("Window is minimized: observe again");
        // Geometrie relue : le point de l'image ne vise le meme pixel que si le cadre n'a pas bouge depuis la capture.
        if (DwmGetWindowAttribute(window, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var now, 16) != 0 || frame.Length != 4 ||
            now.Left != frame[0] || now.Top != frame[1] || now.Width != frame[2] || now.Height != frame[3])
            throw new ActionRefusedException("Window moved or resized since the native capture: observe again");
        if (x < now.Left || y < now.Top || x >= now.Right || y >= now.Bottom) throw new ActionRefusedException("Point is outside the window");
        // Une seule technique par geste : celle de l'interface, jamais une seconde apres un envoi (banc commun du 21/10).
        if (action == "wheel" && wpf)
        {
            EmergencyStop.ThrowIfStopped();
            // Entree potentielle des cet appel : un echec ensuite est une issue inconnue (jamais « rien n'a ete envoye »), et
            // la surveillance du premier plan sous jeton s'applique (relecture de Codex, 21/10). Le processus COM ne leve
            // « non applicable » qu'avant le premier pas.
            started();
            return ComBridge.Call(new { op = "scrollAt", windowId = (long)window, runtimeId = Array.Empty<int>(), x, y, deltaY, deltaX });
        }
        if (action == "wheel" && chromium) return Cdp.Wheel(window, x, y, deltaY, deltaX, started);
        var target = DeepestChild(window, x, y);
        // WinForms ne leve DoubleClick que si la fenetre au point (hit-test) est le controle lui-meme : point recouvert,
        // double clic poste sans effet (banc commun du 22/10, les trois outils) ; rien n'est envoye, l'entree physique
        // (premier plan bref) s'en charge si elle est permise.
        if (count >= 2 && action == "click" && ClassOf(target).StartsWith("WindowsForms10.", StringComparison.Ordinal) &&
            WindowFromPoint(new Win32.Point { X = x, Y = y }) != target)
            throw new BackgroundNotApplicableException("WinForms double click at a covered point has no effect by messages: nothing was sent");
        EmergencyStop.ThrowIfStopped();
        var sent = 0;
        void Post(uint msg, nint wparam, nint lparam)
        {
            if (sent == 0) started(); // au-dela, toute erreur suit une entree : resultat inconnu, jamais rejoue
            try { Win32.Post(target, msg, wparam, lparam); }
            catch (Exception error) when (sent > 0) { throw new InvalidOperationException($"Partial pointer input ({sent} messages posted); outcome unknown", error); }
            sent++;
        }
        if (action == "wheel")
        {
            if (deltaY != 0) Post(WM_MOUSEWHEEL, (nint)((deltaY & 0xFFFF) << 16), Lparam(x, y));
            if (deltaX != 0) Post(WM_MOUSEHWHEEL, (nint)((deltaX & 0xFFFF) << 16), Lparam(x, y));
            return new("background:messages", "WM_MOUSEWHEEL (screen point)", "sent");
        }
        if (!Buttons.TryGetValue(button, out var b)) throw new InvalidOperationException("Invalid mouse button");
        var client = new Win32.Point { X = x, Y = y };
        ScreenToClient(target, ref client);
        // Repere ou la cible LIT le message : pixels logiques pour une fenetre non adaptee au DPI (ou DPI systeme) ;
        // Windows ne convertit jamais un message poste (banc commun du 22/10 : a 125 %, double clic sur la 3e ligne
        // d'une ListBox WinForms tombe une ligne plus bas).
        var scale = Capture.Scale(target);
        if (scale != 1.0) client = new Win32.Point { X = (int)Math.Round(client.X / scale), Y = (int)Math.Round(client.Y / scale) };
        var lp = Lparam(client.X, client.Y);
        var hit = WindowFromPoint(new Win32.Point { X = x, Y = y });
        var thread = Win32.GetWindowThreadProcessId(target, out _);
        var posted = new List<string>();
        void Trace(string state) => LastTrace = new
        {
            target = (long)target, className = ClassOf(target), thread, client = new[] { client.X, client.Y }, screen = new[] { x, y },
            posted = posted.ToArray(), state, hitWindow = (long)hit, hitClass = hit == 0 ? "" : ClassOf(hit), hitIsTarget = hit == target,
            threadAfter = ThreadState(thread),
        };
        try
        {
            Post(WM_MOUSEMOVE, 0, lp); posted.Add("WM_MOUSEMOVE");
            for (var i = 0; i < Math.Clamp(count, 1, 2); i++)
            {
                Post(i == 1 ? b.Dbl : b.Down, b.Mk, lp); // double clic : sequence complete DOWN, UP, DBLCLK, UP
                posted.Add($"0x{(i == 1 ? b.Dbl : b.Down):X4}");
                Post(b.Up, 0, lp); posted.Add($"0x{b.Up:X4}");
            }
        }
        catch { Trace("partial"); throw; }
        Trace("posted");
        return new("background:messages", count == 2 ? "posted double click" : $"posted {button} click", "sent");
    }
}
