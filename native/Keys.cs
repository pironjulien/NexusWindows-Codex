using System.Runtime.InteropServices;

// Touches et raccourcis en arriere-plan (banc commun des trois NexusWindows, 21/10/2026), Win32 et WinForms seulement :
// WM_KEYDOWN/WM_KEYUP postes au focus du fil de la cible ; pour Ctrl/Maj, l'etat clavier de CE fil est simule le temps
// du traitement (AttachThreadInput au seul fil de la cible, jamais a celui du premier plan), puis restaure quand la cible
// a traite ses entrees (WaitForInputIdle), pour que Ctrl+S ne devienne jamais S. Alt et Windows : refus (les raccourcis
// systeme attendent WM_SYSKEYDOWN). WPF, UWP, Chromium, Tk : non applicable (ignorent les touches postees, mesure).
static class Keys
{
    [StructLayout(LayoutKind.Sequential)]
    struct GuiThreadInfo { public int Size, Flags; public nint Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Win32.Rect CaretRect; }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern bool IsChild(nint parent, nint child);
    [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyExW(uint code, uint type, nint layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanExW(char ch, nint layout);
    [DllImport("user32.dll")] static extern nint GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern uint WaitForInputIdle(nint process, uint ms);
    [DllImport("kernel32.dll")] static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint hwnd, char[] name, int max);

    const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
    const int VK_SHIFT = 0x10, VK_CONTROL = 0x11;
    static readonly Dictionary<string, int> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Return"] = 0x0D, ["Enter"] = 0x0D, ["Tab"] = 0x09, ["Escape"] = 0x1B, ["Esc"] = 0x1B, ["BackSpace"] = 0x08,
        ["Delete"] = 0x2E, ["Home"] = 0x24, ["End"] = 0x23, ["Left"] = 0x25, ["Up"] = 0x26, ["Right"] = 0x27, ["Down"] = 0x28,
        ["Page_Up"] = 0x21, ["Prior"] = 0x21, ["Page_Down"] = 0x22, ["Next"] = 0x22, ["space"] = 0x20, ["Insert"] = 0x2D,
    };
    static readonly HashSet<int> Extended = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E];

    static string ClassOf(nint hwnd) { var b = new char[256]; var n = GetClassNameW(hwnd, b, b.Length); return new string(b, 0, Math.Max(0, n)); }

    // « Control_L+s », « ctrl+k », « Return » : (modificateurs, touche). Alt/Windows : refus, rien n'est envoye.
    // Disposition du fil CIBLE (relecture de Codex, 21/10) : celle du helper traduisait « 1 » d'un clavier QWERTY en
    // « & » dans une cible AZERTY, et sa Maj implicite pouvait etre fausse.
    static (List<int> Mods, int Vk) Parse(string spec, nint layout)
    {
        var parts = spec.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) throw new InvalidOperationException("Empty key");
        var mods = new List<int>();
        // Grammaire stricte, la meme que la garde (garde-fous.mjs keyKinds) : aucun autre modificateur accepte.
        foreach (var m in parts[..^1])
        {
            var low = m.ToLowerInvariant();
            if (low is "ctrl" or "control" or "control_l" or "control_r") mods.Add(VK_CONTROL);
            else if (low is "shift" or "shift_l" or "shift_r") mods.Add(VK_SHIFT);
            else throw new BackgroundNotApplicableException($"Modifier {m} has no safe background technique (system keys)");
        }
        var key = parts[^1];
        int vk;
        if (Named.TryGetValue(key, out var named)) vk = named;
        else if (key.Length >= 2 && (key[0] == 'F' || key[0] == 'f') && int.TryParse(key[1..], out var f) && f is >= 1 and <= 12) vk = 0x6F + f;
        else if (key.Length == 1)
        {
            var scan = VkKeyScanExW(key[0], layout);
            if (scan == -1 || ((scan >> 8) & 0x6) != 0) throw new BackgroundNotApplicableException("Key needs AltGr/Ctrl to type: no background technique");
            vk = scan & 0xFF;
            if (((scan >> 8) & 1) != 0 && !mods.Contains(VK_SHIFT)) mods.Add(VK_SHIFT);
        }
        else throw new BackgroundNotApplicableException($"Unknown key {key}");
        return (mods, vk);
    }

    // Meme grammaire pour la vraie frappe (Physical.cs) : la disposition du fil cible, Alt/Windows refuses.
    public static (List<int> Mods, int Vk) ParseFor(string spec, nint layout) => Parse(spec, layout);
    public static bool IsExtended(int vk) => Extended.Contains(vk);

    static nint KeyLparam(int vk, bool up, nint layout)
    {
        long lp = 1 | ((long)(MapVirtualKeyExW((uint)vk, 0, layout) & 0xFF) << 16);
        if (Extended.Contains(vk)) lp |= 1L << 24;
        if (up) lp |= (1L << 30) | (1L << 31);
        return (nint)lp;
    }

    public static Outcome Send(nint window, string spec, Action started)
    {
        var cls = ClassOf(window);
        var classic = !cls.StartsWith("Chrome_WidgetWin_") && !cls.StartsWith("HwndWrapper") && cls != "ApplicationFrameWindow" &&
            !cls.StartsWith("Windows.UI.") && cls != "TkTopLevel" && !cls.StartsWith("Mozilla");
        if (!classic) throw new BackgroundNotApplicableException("This interface ignores posted keys (measured): no background technique");
        var layout = GetKeyboardLayout(Win32.GetWindowThreadProcessId(window, out _));
        var (mods, vk) = Parse(spec, layout);
        // Aucun modificateur par messages postes, Maj implicite d'un caractere comprise : rien ne prouve que la cible
        // traite les touches avant le retrait de l'etat clavier simule (WaitForInputIdle n'en est pas un accuse ;
        // relecture de Codex, 21/10). Refus avant toute entree ; le repli physique ou une commande semantique s'en charge.
        if (mods.Count > 0) throw new BackgroundNotApplicableException("A key with a modifier has no proven background technique");
        var thread = Win32.GetWindowThreadProcessId(window, out var pid);
        var fg = Win32.GetForegroundWindow();
        if (thread == 0) throw new BackgroundNotApplicableException("Window thread unknown");
        if (fg != 0 && Win32.GetWindowThreadProcessId(fg, out _) == thread)
            throw new BackgroundNotApplicableException("The target shares the foreground thread: simulated keyboard state refused");
        var info = new GuiThreadInfo { Size = Marshal.SizeOf<GuiThreadInfo>() };
        var target = GetGUIThreadInfo(thread, ref info) && info.Focus != 0 && (info.Focus == window || IsChild(window, info.Focus)) ? info.Focus : window;
        EmergencyStop.ThrowIfStopped();
        var sent = 0;
        void Post(uint msg, int key, bool up)
        {
            if (sent == 0) started(); // au-dela, toute erreur suit une entree : resultat inconnu
            try { Win32.Post(target, msg, key, KeyLparam(key, up, layout)); }
            catch (Exception error) when (sent > 0) { throw new InvalidOperationException($"Partial key input ({sent} messages posted); outcome unknown", error); }
            sent++;
        }
        Post(WM_KEYDOWN, vk, false);
        Post(WM_KEYUP, vk, true);
        return new("background:messages", "WM_KEYDOWN/WM_KEYUP", "sent");
    }
}
