using System.Runtime.InteropServices;
using System.Text;

// Declarations Win32 partagees par les techniques d'arriere-plan, la capture, les fenetres liees et la presence.
static class Win32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
        public readonly bool Empty => Width <= 0 || Height <= 0;
        public readonly Rect Intersect(Rect o) => new() { Left = Math.Max(Left, o.Left), Top = Math.Max(Top, o.Top), Right = Math.Min(Right, o.Right), Bottom = Math.Min(Bottom, o.Bottom) };
    }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LastInputInfo { public uint Size; public uint Time; }

    public const uint WM_COMMAND = 0x0111, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E;
    public const uint WM_INITMENU = 0x0116, WM_INITMENUPOPUP = 0x0117, WM_UNINITMENUPOPUP = 0x0125;
    public const uint BM_GETCHECK = 0x00F0, BM_SETCHECK = 0x00F1;
    public const uint EM_SETSEL = 0x00B1, EM_REPLACESEL = 0x00C2;
    public const uint CB_GETCOUNT = 0x0146, CB_GETCURSEL = 0x0147, CB_GETLBTEXT = 0x0148, CB_GETLBTEXTLEN = 0x0149, CB_SETCURSEL = 0x014E,
        CB_SHOWDROPDOWN = 0x014F, CB_GETDROPPEDSTATE = 0x0157;
    public const uint LB_SETCURSEL = 0x0186, LB_GETCURSEL = 0x0188, LB_GETTEXT = 0x0189, LB_GETTEXTLEN = 0x018A, LB_GETCOUNT = 0x018B;
    public const uint TCM_GETITEMCOUNT = 0x1304, TCM_GETCURSEL = 0x130B, TCM_SETCURFOCUS = 0x1330;
    public const int GWL_STYLE = -16;
    public const uint GW_OWNER = 4, GA_ROOT = 2;
    public const int ES_MULTILINE = 0x4, ES_PASSWORD = 0x20, ES_READONLY = 0x800;
    public const int LBS_MULTIPLESEL = 0x8, LBS_EXTENDEDSEL = 0x800;
    public const int WS_DISABLED = 0x08000000;

    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(nint hwnd, ref Point point);
    [DllImport("user32.dll")] static extern nint SendMessageTimeoutW(nint hwnd, uint msg, nint wparam, ref Rect lparam, uint flags, uint timeout, out nint result);
    // Rectangle (client) de l'element `index` d'une LISTBOX (LB_GETITEMRECT), sans attente infinie (SMTO_ABORTIFHUNG).
    public static bool ItemRect(nint list, int index, out Rect rect)
    {
        rect = default;
        return SendMessageTimeoutW(list, 0x0198, index, ref rect, 0x0002, 1000, out var ok) != 0 && ok != -1;
    }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("user32.dll")] public static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool doAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(nint hwnd, int attribute, out int value, int size);
    // Fenetre masquee par le gestionnaire de fenetres (bureau virtuel, application suspendue) : DWMWA_CLOAKED.
    public static bool IsCloaked(nint hwnd) => DwmGetWindowAttributeInt(hwnd, 14, out var cloaked, sizeof(int)) == 0 && cloaked != 0;
    [DllImport("user32.dll")] public static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] public static extern nint GetAncestor(nint hwnd, uint flags);
    [DllImport("user32.dll")] public static extern nint GetParent(nint hwnd);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(nint hwnd);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(nint hwnd, int index);
    [DllImport("user32.dll")] public static extern nint GetNextDlgGroupItem(nint dialog, nint control, bool previous);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint hwnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(nint hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern nint FindWindowExW(nint parent, nint after, string? cls, string? title);
    public delegate bool EnumProc(nint hwnd, nint data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, nint data);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(nint parent, EnumProc callback, nint data);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(nint hwnd, uint msg, nint wparam, nint lparam);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    static extern nint SendMessageTimeout(nint hwnd, uint msg, nint wparam, nint lparam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    static extern nint SendMessageTimeoutText(nint hwnd, uint msg, nint wparam, string lparam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    static extern nint SendMessageTimeoutBuffer(nint hwnd, uint msg, nint wparam, [Out] char[] lparam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(nint hwnd, int attribute, out Rect rect, int size);

    // Menus Win32 (HMENU) : objets utilisateur globaux, lisibles depuis un autre processus.
    [DllImport("user32.dll")] public static extern nint GetMenu(nint hwnd);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(nint menu);
    [DllImport("user32.dll")] public static extern nint GetSubMenu(nint menu, int position);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(nint menu, int position);
    [DllImport("user32.dll")] public static extern uint GetMenuState(nint menu, uint id, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuStringW(nint menu, uint id, StringBuilder text, int max, uint flags);

    // DPI
    [DllImport("user32.dll")] public static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] public static extern nint GetWindowDpiAwarenessContext(nint hwnd);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] public static extern nint MonitorFromWindow(nint hwnd, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(nint monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(nint hwnd);

    // GDI
    [DllImport("user32.dll")] public static extern nint GetDC(nint hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(nint hwnd, nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateDIBSection(nint dc, ref BitmapInfoHeader header, uint usage, out nint bits, nint section, uint offset);
    [DllImport("gdi32.dll")] public static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll")] public static extern bool GdiFlush();
    [DllImport("user32.dll")] public static extern bool PrintWindow(nint hwnd, nint dc, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    public struct BitmapInfoHeader
    {
        public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter; public uint ClrUsed, ClrImportant;
    }

    const uint SMTO_ABORTIFHUNG = 0x2;
    const uint MessageTimeoutMs = 2000;

    // SendMessage borne : une application figee ne bloque pas le helper ; null = pas de reponse.
    public static nint? Send(nint hwnd, uint msg, nint wparam = 0, nint lparam = 0) =>
        SendMessageTimeout(hwnd, msg, wparam, lparam, SMTO_ABORTIFHUNG, MessageTimeoutMs, out var result) == 0 ? null : result;
    public static nint? SendText(nint hwnd, uint msg, nint wparam, string text) =>
        SendMessageTimeoutText(hwnd, msg, wparam, text, SMTO_ABORTIFHUNG, MessageTimeoutMs, out var result) == 0 ? null : result;
    public static string? SendGetText(nint hwnd, uint lengthMsg, uint textMsg, nint index, bool indexed)
    {
        var length = indexed ? Send(hwnd, lengthMsg, index) : Send(hwnd, lengthMsg);
        if (length is null || length < 0 || length > 0x100000) return null;
        var buffer = new char[(int)length + 2];
        var copied = indexed
            ? SendMessageTimeoutBuffer(hwnd, textMsg, index, buffer, SMTO_ABORTIFHUNG, MessageTimeoutMs, out var r1) == 0 ? -1 : r1
            : SendMessageTimeoutBuffer(hwnd, textMsg, buffer.Length, buffer, SMTO_ABORTIFHUNG, MessageTimeoutMs, out var r2) == 0 ? -1 : r2;
        if (copied < 0) return null;
        return new string(buffer, 0, (int)Math.Min(copied, (nint)(buffer.Length - 1)));
    }
    public static string WindowText(nint hwnd) => SendGetText(hwnd, WM_GETTEXTLENGTH, WM_GETTEXT, 0, false) ?? throw new BackgroundNotApplicableException("Control does not answer text requests");

    public static string ClassName(nint hwnd)
    {
        var name = new StringBuilder(256);
        return GetClassNameW(hwnd, name, name.Capacity) > 0 ? name.ToString() : "";
    }
    // Classe Win32 sous-jacente, en minuscules : « WindowsForms10.BUTTON.app.0.x » -> « button ».
    public static string BaseClass(nint hwnd)
    {
        var cls = ClassName(hwnd).ToLowerInvariant();
        if (cls.StartsWith("windowsforms", StringComparison.Ordinal))
        {
            var parts = cls.Split('.');
            if (parts.Length > 1) cls = parts[1];
        }
        return cls;
    }
    public static string Title(nint hwnd)
    {
        var text = new StringBuilder(512);
        return GetWindowTextW(hwnd, text, text.Capacity) > 0 ? text.ToString() : "";
    }
    public static string MenuLabel(nint menu, int position)
    {
        var text = new StringBuilder(256);
        GetMenuStringW(menu, (uint)position, text, text.Capacity, 0x400 /* MF_BYPOSITION */);
        return text.ToString();
    }
    public static int Style(nint hwnd) => GetWindowLongW(hwnd, GWL_STYLE);
    public static int ExStyle(nint hwnd) => GetWindowLongW(hwnd, -20 /* GWL_EXSTYLE */);
    // Surgissante transitoire : WS_POPUP sans barre de titre qui ne s'active pas (WS_EX_NOACTIVATE : liste deroulante,
    // infobulle, surgissante WPF), ou liste ouverte d'une liste deroulante Win32 (ComboLBox).
    // `bound` : fenetre suivie. Menu WinForms : role UIA « menu » de la surgissante et lien a la fenetre suivie (meme fil
    // d'interface, ou possedee par elle) exiges, lus seulement pour une fenetre outil WinForms sans barre de titre.
    public static bool IsTransientPopup(nint hwnd, string cls, nint bound)
    {
        var (style, ex) = (unchecked((uint)Style(hwnd)), unchecked((uint)ExStyle(hwnd)));
        var winformsTool = (style & 0x80000000) != 0 && (style & 0x00C00000) != 0x00C00000 && (ex & 0x88) != 0 && cls.StartsWith("WindowsForms10.", StringComparison.Ordinal);
        var menu = winformsTool && MenuRole(hwnd);
        var linked = winformsTool && (GetWindowThreadProcessId(hwnd, out _) == GetWindowThreadProcessId(bound, out _) || OwnedBy(hwnd, bound));
        return IsTransientPopupStyle(style, ex, cls, menu, linked);
    }
    // Menus ouverts lies a la fenetre suivie : fenetres de premier niveau visibles du meme processus, dans l'ordre Z.
    // WinForms (ContextMenuStrip, ToolStripDropDown) : surgissante transitoire prouvee (role menu ET lien). WPF
    // (ContextMenu, mesure du 22/10) : surgissante HwndWrapper sans activation POSSEDEE par la fenetre suivie, du meme fil,
    // contenant un menu UIA (sa racine est une « fenetre » : role lu dans son arbre).
    public static List<nint> LinkedMenuPopups(nint bound)
    {
        var pid = ProcessOf(bound);
        var found = new List<nint>();
        EnumWindows((h, _) =>
        {
            if (h != bound && IsWindowVisible(h) && ProcessOf(h) == pid && ClassName(h) is var cls &&
                (cls.StartsWith("WindowsForms10.", StringComparison.Ordinal) && IsTransientPopup(h, cls, bound) ||
                 cls.StartsWith("HwndWrapper", StringComparison.Ordinal) && IsWpfMenuPopup(h, bound))) found.Add(h);
            return true;
        }, 0);
        return found;
    }
    static bool IsWpfMenuPopup(nint hwnd, nint bound)
    {
        var (style, ex) = (unchecked((uint)Style(hwnd)), unchecked((uint)ExStyle(hwnd)));
        if ((style & 0x80000000) == 0 || (style & 0x00C00000) == 0x00C00000 || (ex & 0x08000000) == 0) return false; // WS_POPUP, sans titre, NOACTIVATE
        if (GetWindow(hwnd, GW_OWNER) != bound || GetWindowThreadProcessId(hwnd, out _) != GetWindowThreadProcessId(bound, out _)) return false;
        try
        {
            using var tree = ComUia.Shared.ReadTree(hwnd, withPopups: false);
            return tree.Nodes.Any(n => n.Role == "menu");
        }
        catch (Exception) { return false; }
    }
    static bool MenuRole(nint hwnd)
    {
        try { return ComUia.Shared.ControlTypeOfWindow(hwnd) == 50009 /* Menu */; }
        catch (Exception) { return false; }
    }
    static bool OwnedBy(nint hwnd, nint bound)
    {
        for (var (owner, n) = (GetWindow(hwnd, GW_OWNER), 0); owner != 0 && n < 16; owner = GetWindow(owner, GW_OWNER), n++) if (owner == bound) return true;
        return false;
    }

    // Surgissante transitoire d'apres styles et classe (fonction pure, testee hors ligne : --popup-selftest).
    public static bool IsTransientPopupStyle(uint style, uint ex, string cls, bool menuRole = false, bool linked = false)
    {
        if (string.Equals(cls, "ComboLBox", StringComparison.OrdinalIgnoreCase)) return true;
        const uint WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TOPMOST = 0x00000008;
        if ((style & WS_POPUP) == 0 || (style & WS_CAPTION) == WS_CAPTION) return false;
        if ((ex & WS_EX_NOACTIVATE) != 0) return true;
        // Menu deroulant ou contextuel WinForms (ToolStripDropDown) : fenetre outil sans barre de titre, sans
        // WS_EX_NOACTIVATE ; jamais suivie comme une nouvelle fenetre, signalee dans obs.popups (banc commun du 21/10 :
        // le menu contextuel ouvert n'etait ni suivi ni signale, « found 0 »). Le style seul ne prouve rien (une palette
        // persistante a le meme, relecture de Codex du 22/10) : role UIA « menu » ET lien a la fenetre suivie exiges.
        // ContextMenuStrip mesure le 22/10 (labo WinForms) : WS_EX_TOPMOST | WS_EX_CONTROLPARENT, SANS WS_EX_TOOLWINDOW ; le
        // clic droit l'ouvrait mais le helper ne le reconnaissait pas (« contextMenu: null »).
        return (ex & (WS_EX_TOOLWINDOW | WS_EX_TOPMOST)) != 0 && cls.StartsWith("WindowsForms10.", StringComparison.Ordinal) && menuRole && linked;
    }

    public static int PopupSelfTest()
    {
        using var input = System.Text.Json.JsonDocument.Parse(Console.In.ReadToEnd());
        var results = input.RootElement.EnumerateArray()
            .Select(c => IsTransientPopupStyle(c.GetProperty("style").GetUInt32(), c.GetProperty("ex").GetUInt32(), c.GetProperty("cls").GetString() ?? "",
                c.TryGetProperty("menu", out var m) && m.GetBoolean(), c.TryGetProperty("linked", out var l) && l.GetBoolean())).ToList();
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(results));
        return 0;
    }
    public static uint ProcessOf(nint hwnd) { GetWindowThreadProcessId(hwnd, out var pid); return pid; }

    // PostMessage verifie : un refus (fenetre disparue, application elevee bloquee par UIPI) n'est jamais un succes.
    public static void Post(nint hwnd, uint msg, nint wparam, nint lparam)
    {
        if (!PostMessageW(hwnd, msg, wparam, lparam))
        {
            var error = Marshal.GetLastWin32Error();
            throw new InvalidOperationException(error == 5 ? "Windows blocks messages to this application (elevated, UIPI)" : $"PostMessage refused (error {error})");
        }
    }

    public static (nint Foreground, Point Cursor, uint LastInput) Probe()
    {
        GetCursorPos(out var cursor);
        var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
        GetLastInputInfo(ref info);
        return (GetForegroundWindow(), cursor, info.Time);
    }
}
