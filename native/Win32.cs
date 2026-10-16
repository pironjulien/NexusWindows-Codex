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
    public const uint BM_GETCHECK = 0x00F0, BM_SETCHECK = 0x00F1;
    public const uint EM_SETSEL = 0x00B1, EM_REPLACESEL = 0x00C2;
    public const uint CB_GETCOUNT = 0x0146, CB_GETCURSEL = 0x0147, CB_GETLBTEXT = 0x0148, CB_GETLBTEXTLEN = 0x0149, CB_SETCURSEL = 0x014E;
    public const uint LB_SETCURSEL = 0x0186, LB_GETCURSEL = 0x0188, LB_GETTEXT = 0x0189, LB_GETTEXTLEN = 0x018A, LB_GETCOUNT = 0x018B;
    public const uint TCM_GETITEMCOUNT = 0x1304, TCM_GETCURSEL = 0x130B, TCM_SETCURFOCUS = 0x1330;
    public const int GWL_STYLE = -16;
    public const uint GW_OWNER = 4, GA_ROOT = 2;
    public const int ES_MULTILINE = 0x4, ES_PASSWORD = 0x20, ES_READONLY = 0x800;
    public const int LBS_MULTIPLESEL = 0x8, LBS_EXTENDEDSEL = 0x800;
    public const int WS_DISABLED = 0x08000000;

    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("user32.dll")] public static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
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
    [DllImport("user32.dll")] public static extern uint GetSystemDpiForProcess(nint process);

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
