using System.Diagnostics;
using System.Runtime.InteropServices;

// Indicateur « agent au travail » : le logo pi de Julien tourne sur lui-meme (axe vertical, 1,618 s par tour) en bas a
// droite de l'ecran de la fenetre pilotee, comme un ecran de chargement de jeu, sans halo (le logo seul, avec son
// ombre ; demande de Julien du 22/10). Affiche par le garde (--stop-guard, processus long de la session) sur la commande
// « busy <hwnd> », retire 1,618 s apres « idle ». Fenetre en couches toujours devant, sans bordure, transparente aux
// clics, jamais activee, absente de la barre des taches (fenetre d'outil) et des captures (WDA_EXCLUDEFROMCAPTURE).
// Rendu analytique (ombre, piece) a partir de logo.png decode par GDI+ : aucune dependance ajoutee.
// NEXUS_WINDOWS_INDICATOR=0 le coupe.
static class BusyIndicator
{
    public const int LingerMs = 1618, PeriodMs = 1618, Frames = 48, FadeMs = 300, Size = 72, Margin = 28;
    const double Canvas = 2.0;

    static readonly object Gate = new();
    static readonly AutoResetEvent Wake = new(false);
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static bool active;
    static long lastEnd = -LingerMs;
    static nint target;
    static Thread? thread;
    static readonly Dictionary<int, byte[][]> Cache = new();
    static (int Width, int Height, byte[] Pixels)? logo; // BGRA non premultiplie

    public static bool Enabled => Environment.GetEnvironmentVariable("NEXUS_WINDOWS_INDICATOR") != "0";

    public static void Busy(nint hwnd)
    {
        if (!Enabled) return;
        lock (Gate)
        {
            active = true;
            if (hwnd != 0) target = hwnd;
            if (thread is not { IsAlive: true })
            {
                thread = new Thread(Run) { IsBackground = true, Name = "nexus-busy-indicator" };
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
            }
        }
        Wake.Set();
    }

    public static void Idle()
    {
        lock (Gate) { if (active) { active = false; lastEnd = Clock.ElapsedMilliseconds; } }
    }

    static bool IsBusy() { lock (Gate) return active || Clock.ElapsedMilliseconds - lastEnd < LingerMs; }

    // ---- Courbes d'animation (identiques a NexusBrowser) ----
    static double Bezier(double x1, double y1, double x2, double y2, double t)
    {
        double lo = 0, hi = 1;
        for (var i = 0; i < 40; i++)
        {
            var u = (lo + hi) / 2;
            var x = 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u;
            if (x < t) lo = u; else hi = u;
        }
        var v = (lo + hi) / 2;
        return 3 * y1 * v * (1 - v) * (1 - v) + 3 * y2 * v * v * (1 - v) + v * v * v;
    }
    public static double AngleAt(double phase) => 360 * Bezier(0.45, 0, 0.55, 1, phase - Math.Floor(phase));

    // ---- Rendu ----
    static (int, int, byte[]) Logo()
    {
        if (logo is { } known) return known;
        var path = Path.Combine(AppContext.BaseDirectory, "logo.png");
        var input = new GdiplusStartupInput { Version = 1 };
        if (GdiplusStartup(out var token, ref input, 0) != 0) throw new InvalidOperationException("GDI+ unavailable");
        try
        {
            if (GdipCreateBitmapFromFile(path, out var bitmap) != 0) throw new FileNotFoundException("Indicator logo unreadable", path);
            try
            {
                GdipGetImageWidth(bitmap, out var width); GdipGetImageHeight(bitmap, out var height);
                var rect = new GpRect { Width = (int)width, Height = (int)height };
                var data = new BitmapData();
                if (GdipBitmapLockBits(bitmap, ref rect, 1, 0x26200A, ref data) != 0) throw new InvalidOperationException("Logo pixels unreadable");
                var pixels = new byte[width * height * 4];
                for (var y = 0; y < height; y++) Marshal.Copy(data.Scan0 + y * data.Stride, pixels, (int)(y * width * 4), (int)width * 4);
                GdipBitmapUnlockBits(bitmap, ref data);
                logo = ((int)width, (int)height, pixels);
                return logo.Value;
            }
            finally { GdipDisposeImage(bitmap); }
        }
        finally { GdiplusShutdown(token); }
    }

    static double Clamp01(double v) => v < 0 ? 0 : v > 1 ? 1 : v;
    static double Erf(double x)
    {
        // Abramowitz-Stegun 7.1.26 (erreur < 1,5e-7) : bord flou d'un disque (ombre gaussienne).
        var s = Math.Sign(x); x = Math.Abs(x);
        var t = 1 / (1 + 0.3275911 * x);
        var y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.Exp(-x * x);
        return s * y;
    }

    // Piece : logo rond reduit par moyenne de surface, liseré blanc 0,18 sur 2 px. RGBA premultiplie en double.
    static double[] Coin(int diameter, int ring, out int side)
    {
        var (lw, lh, lp) = Logo();
        side = diameter + 2 * ring;
        var coin = new double[side * side * 4];
        double radius = diameter / 2.0, outer = side / 2.0;
        const int Super = 4;
        for (var y = 0; y < side; y++)
            for (var x = 0; x < side; x++)
            {
                double r = 0, g = 0, b = 0, a = 0;
                for (var sy = 0; sy < Super; sy++)
                    for (var sx = 0; sx < Super; sx++)
                    {
                        var px = x + (sx + 0.5) / Super; var py = y + (sy + 0.5) / Super;
                        var dist = Math.Sqrt((px - outer) * (px - outer) + (py - outer) * (py - outer));
                        if (dist > outer) continue;
                        double cr = 1, cg = 1, cb = 1, ca = 0.18; // liseré
                        if (dist <= radius)
                        {
                            var lx = (int)((px - ring) / diameter * lw); var ly = (int)((py - ring) / diameter * lh);
                            lx = Math.Clamp(lx, 0, lw - 1); ly = Math.Clamp(ly, 0, lh - 1);
                            var i = (ly * lw + lx) * 4;
                            var la = lp[i + 3] / 255.0;
                            cr = cr * ca * (1 - la) + lp[i + 2] / 255.0 * la; cg = cg * ca * (1 - la) + lp[i + 1] / 255.0 * la;
                            cb = cb * ca * (1 - la) + lp[i] / 255.0 * la; ca = la + ca * (1 - la);
                            a += ca; r += cr; g += cg; b += cb; continue;
                        }
                        a += ca; r += cr * ca; g += cg * ca; b += cb * ca;
                    }
                const double N = Super * Super;
                var o = (y * side + x) * 4;
                coin[o] = r / N; coin[o + 1] = g / N; coin[o + 2] = b / N; coin[o + 3] = a / N;
            }
        return coin;
    }

    public static byte[][] RenderFrames(int diameter, int count = Frames)
    {
        var scale = diameter / 72.0;
        var ring = Math.Max(1, (int)Math.Round(2 * scale));
        var coin = Coin(diameter, ring, out var coinSide);
        var side = (int)Math.Round(diameter * Canvas);
        var center = side / 2.0;
        var radius = diameter / 2.0;
        var sigma = 11 * scale;
        var frames = new byte[count][];
        var buffer = new double[side * side * 4];
        for (var f = 0; f < count; f++)
        {
            Array.Clear(buffer);
            var phase = (double)f / count;
            // Sans halo (demande de Julien du 22/10 : le fond bleu-violet faisait « moche ») : la piece et son ombre seules.
            var cos = Math.Cos(AngleAt(phase) * Math.PI / 180);
            var squeeze = Math.Abs(cos);
            if (squeeze > 0.02)
            {
                // Ombre portee (0 8px 22px noir 0,55), ecrasee avec la piece.
                var shadowY = center + 8 * scale;
                for (var y = 0; y < side; y++)
                    for (var x = 0; x < side; x++)
                    {
                        var dx = (x + 0.5 - center) / squeeze; var dy = y + 0.5 - shadowY;
                        var a = 0.55 * 0.5 * (1 + Erf((radius - Math.Sqrt(dx * dx + dy * dy)) / (sigma * Math.Sqrt(2))));
                        if (a < 0.002) continue;
                        Over(buffer, (y * side + x) * 4, 0, 0, 0, a);
                    }
                // Piece : colonnes reduites par moyenne de surface, revers en miroir.
                var width = Math.Max(1, (int)Math.Round(coinSide * squeeze));
                var left = (int)Math.Round(center - width / 2.0); var top = (int)Math.Round(center - coinSide / 2.0);
                var step = (double)coinSide / width;
                for (var x = 0; x < width; x++)
                {
                    double from = x * step, to = from + step;
                    for (var y = 0; y < coinSide; y++)
                    {
                        double r = 0, g = 0, b = 0, a = 0;
                        for (var c = (int)from; c < Math.Min(coinSide, (int)Math.Ceiling(to)); c++)
                        {
                            var w = Math.Min(to, c + 1) - Math.Max(from, c);
                            var column = cos < 0 ? coinSide - 1 - c : c;
                            var i = (y * coinSide + column) * 4;
                            r += coin[i] * w; g += coin[i + 1] * w; b += coin[i + 2] * w; a += coin[i + 3] * w;
                        }
                        var ox = left + x; var oy = top + y;
                        if (ox < 0 || oy < 0 || ox >= side || oy >= side) continue;
                        var o = (oy * side + ox) * 4;
                        var src = a / step;
                        buffer[o] = r / step + buffer[o] * (1 - src); buffer[o + 1] = g / step + buffer[o + 1] * (1 - src);
                        buffer[o + 2] = b / step + buffer[o + 2] * (1 - src); buffer[o + 3] = src + buffer[o + 3] * (1 - src);
                    }
                }
            }
            var frame = new byte[side * side * 4];
            for (var p = 0; p < side * side; p++)
            {
                // BGRA premultiplie pour UpdateLayeredWindow.
                frame[p * 4] = ToByte(buffer[p * 4 + 2]); frame[p * 4 + 1] = ToByte(buffer[p * 4 + 1]);
                frame[p * 4 + 2] = ToByte(buffer[p * 4]); frame[p * 4 + 3] = ToByte(buffer[p * 4 + 3]);
            }
            frames[f] = frame;
        }
        return frames;
    }

    static void Over(double[] buffer, int o, double r, double g, double b, double a)
    {
        buffer[o] = r * a + buffer[o] * (1 - a); buffer[o + 1] = g * a + buffer[o + 1] * (1 - a);
        buffer[o + 2] = b * a + buffer[o + 2] * (1 - a); buffer[o + 3] = a + buffer[o + 3] * (1 - a);
    }
    static byte ToByte(double v) => (byte)Math.Clamp((int)Math.Round(v * 255), 0, 255);

    static byte[] Scaled(byte[] frame, int side, double factor)
    {
        var result = new byte[frame.Length];
        var size = factor * side; var offset = (side - size) / 2;
        for (var y = 0; y < side; y++)
            for (var x = 0; x < side; x++)
            {
                var sx = (x + 0.5 - offset) / factor - 0.5; var sy = (y + 0.5 - offset) / factor - 0.5;
                if (sx < -0.5 || sy < -0.5 || sx > side - 0.5 || sy > side - 0.5) continue;
                int x0 = Math.Clamp((int)Math.Floor(sx), 0, side - 1), y0 = Math.Clamp((int)Math.Floor(sy), 0, side - 1);
                int x1 = Math.Min(x0 + 1, side - 1), y1 = Math.Min(y0 + 1, side - 1);
                double fx = Clamp01(sx - x0), fy = Clamp01(sy - y0);
                for (var c = 0; c < 4; c++)
                {
                    var v = frame[(y0 * side + x0) * 4 + c] * (1 - fx) * (1 - fy) + frame[(y0 * side + x1) * 4 + c] * fx * (1 - fy)
                        + frame[(y1 * side + x0) * 4 + c] * (1 - fx) * fy + frame[(y1 * side + x1) * 4 + c] * fx * fy;
                    result[(y * side + x) * 4 + c] = (byte)Math.Clamp((int)Math.Round(v), 0, 255);
                }
            }
        return result;
    }

    // ---- Fenetre ----
    delegate nint WndProc(nint hwnd, uint msg, nint wparam, nint lparam);
    static WndProc? proc; // garde le delegue en vie
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClassEx
    {
        public uint Size, Style; public WndProc Proc; public int ClassExtra, WindowExtra; public nint Instance, Icon, Cursor, Background;
        public string? MenuName; public string ClassName; public nint SmallIcon;
    }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SizeS { public int Cx, Cy; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct Blend { public byte Op, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] struct Msg { public nint Hwnd; public uint Message; public nuint WParam; public nint LParam; public uint Time; public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfoHeader { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, SizeImage; public int XPpm, YPpm; public uint ClrUsed, ClrImportant; }
    [StructLayout(LayoutKind.Sequential)] struct GdiplusStartupInput { public uint Version; public nint Callback; public int SuppressThread, SuppressCodecs; }
    [StructLayout(LayoutKind.Sequential)] struct GpRect { public int X, Y, Width, Height; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapData { public uint Width, Height; public int Stride, PixelFormat; public nint Scan0; public nuint Reserved; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassExW(ref WndClassEx wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern nint CreateWindowExW(uint exStyle, string cls, string? title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);
    [DllImport("user32.dll")] static extern nint DefWindowProcW(nint hwnd, uint msg, nint wparam, nint lparam);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(nint hwnd, uint affinity);
    [DllImport("user32.dll")] static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(nint hwnd, nint dst, ref Point pos, ref SizeS size, nint src, ref Point srcPos, uint key, ref Blend blend, uint flags);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out Msg msg, nint hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern nint DispatchMessageW(ref Msg msg);
    [DllImport("user32.dll")] static extern nint GetDC(nint hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern nint MonitorFromWindow(nint hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfoW(nint monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(nint monitor, int type, out uint x, out uint y);
    [DllImport("gdi32.dll")] static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] static extern nint CreateDIBSection(nint dc, ref BitmapInfoHeader header, uint usage, out nint bits, nint section, uint offset);
    [DllImport("gdi32.dll")] static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(nint obj);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern nint GetModuleHandleW(string? name);
    [DllImport("gdiplus.dll")] static extern int GdiplusStartup(out nuint token, ref GdiplusStartupInput input, nint output);
    [DllImport("gdiplus.dll")] static extern void GdiplusShutdown(nuint token);
    [DllImport("gdiplus.dll", CharSet = CharSet.Unicode)] static extern int GdipCreateBitmapFromFile(string path, out nint bitmap);
    [DllImport("gdiplus.dll")] static extern int GdipGetImageWidth(nint image, out uint width);
    [DllImport("gdiplus.dll")] static extern int GdipGetImageHeight(nint image, out uint height);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapLockBits(nint bitmap, ref GpRect rect, uint flags, int format, ref BitmapData data);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapUnlockBits(nint bitmap, ref BitmapData data);
    [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(nint image);

    const uint WsPopup = 0x80000000;
    const uint WsEx = 0x80000 | 0x20 | 0x8 | 0x80 | 0x08000000; // LAYERED | TRANSPARENT | TOPMOST | TOOLWINDOW | NOACTIVATE
    const uint ExcludeFromCapture = 0x11;
    const uint SwpFlags = 0x0001 | 0x0002 | 0x0010 | 0x0040 | 0x0200; // NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW | NOOWNERZORDER
    public const string ClassName = "NexusCodexBusyIndicator";

    public static nint Window { get; private set; }
    public static (int X, int Y, int Side)? ShownAt { get; private set; }

    static ((int L, int T, int R, int B) Work, double Scale) MonitorOf(nint hwnd)
    {
        if (hwnd == 0 || !IsWindow(hwnd)) hwnd = GetForegroundWindow();
        var monitor = MonitorFromWindow(hwnd, 2); // MONITOR_DEFAULTTONEAREST
        var info = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
        GetMonitorInfoW(monitor, ref info);
        var scale = GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 && dpi > 0 ? dpi / 96.0 : 1.0;
        return ((info.Work.Left, info.Work.Top, info.Work.Right, info.Work.Bottom), scale);
    }

    static double Fade(long now, long since, bool fadeOut)
    {
        var k = Clamp01((now - since) / (double)FadeMs);
        return fadeOut ? 1 - k : k;
    }

    static void Run()
    {
        try { Loop(); }
        catch (Exception error) { ShownAt = null; EmergencyStop.Emit(new { @event = "indicator", error = error.GetType().Name + ": " + error.Message }); }
    }

    static void Loop()
    {
        SetThreadDpiAwarenessContext(-4); // PER_MONITOR_AWARE_V2 : position et taille en pixels reels de chaque ecran
        proc = (h, m, w, l) => DefWindowProcW(h, m, w, l);
        var instance = GetModuleHandleW(null);
        var cls = new WndClassEx { Size = (uint)Marshal.SizeOf<WndClassEx>(), Proc = proc, Instance = instance, ClassName = ClassName };
        RegisterClassExW(ref cls); // deja enregistree apres une relance du fil : sans effet
        Window = CreateWindowExW(WsEx, ClassName, "NexusCodex", WsPopup, 0, 0, 1, 1, 0, 0, instance, 0);
        if (Window == 0) throw new InvalidOperationException("CreateWindowExW failed: " + Marshal.GetLastWin32Error());
        SetWindowDisplayAffinity(Window, ExcludeFromCapture);
        var screen = GetDC(0);
        var memory = CreateCompatibleDC(screen);
        nint bitmap = 0, bits = 0;
        var side = 0;
        while (true)
        {
            Wake.WaitOne();
            if (!IsBusy()) continue; // signal d'une action deja finie et retiree
            var start = Clock.ElapsedMilliseconds;
            long visibleSince = start; long? hideFrom = null;
            while (true)
            {
                while (PeekMessageW(out var msg, 0, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
                var now = Clock.ElapsedMilliseconds;
                if (IsBusy())
                {
                    if (hideFrom is { } h) { visibleSince = now - (long)(FadeMs * Fade(now, h, true)); hideFrom = null; }
                }
                else hideFrom ??= now;
                if (hideFrom is { } end && now - end >= FadeMs) break;
                nint goal; lock (Gate) goal = target;
                var (work, scale) = MonitorOf(goal);
                var diameter = Math.Max(24, (int)Math.Round(Size * scale));
                if (!Cache.TryGetValue(diameter, out var frames)) Cache[diameter] = frames = RenderFrames(diameter);
                var newSide = (int)Math.Round(diameter * Canvas);
                if (newSide != side)
                {
                    if (bitmap != 0) DeleteObject(bitmap);
                    var header = new BitmapInfoHeader { Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(), Width = newSide, Height = -newSide, Planes = 1, BitCount = 32 };
                    bitmap = CreateDIBSection(screen, ref header, 0, out bits, 0, 0);
                    SelectObject(memory, bitmap);
                    side = newSide;
                }
                var frame = frames[(int)((now - start) * Frames / PeriodMs % Frames)];
                var grow = hideFrom is { } fading ? Fade(now, fading, true) : Fade(now, visibleSince, false);
                var pixels = grow >= 1 ? frame : Scaled(frame, side, 0.6 + 0.4 * Bezier(0.34, 1.56, 0.64, 1, grow));
                Marshal.Copy(pixels, 0, bits, pixels.Length);
                var margin = (int)Math.Round(Margin * scale);
                var position = new Point { X = work.R - margin - diameter / 2 - side / 2, Y = work.B - margin - diameter / 2 - side / 2 };
                var size = new SizeS { Cx = side, Cy = side };
                var origin = new Point();
                var blend = new Blend { Op = 0, Flags = 0, Alpha = (byte)Math.Clamp((int)Math.Round(255 * grow), 0, 255), Format = 1 };
                UpdateLayeredWindow(Window, screen, ref position, ref size, memory, ref origin, 0, ref blend, 2);
                SetWindowPos(Window, -1, 0, 0, 0, 0, SwpFlags); // toujours devant, sans activation
                ShownAt = (position.X, position.Y, side);
                var spent = Clock.ElapsedMilliseconds - now;
                Thread.Sleep((int)Math.Max(0, PeriodMs / Frames - spent));
            }
            ShowWindow(Window, 0);
            ShownAt = null;
        }
    }
}
