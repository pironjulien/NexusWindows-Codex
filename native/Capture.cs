using System.Diagnostics;
using System.IO;
using System.IO.Compression;

sealed class CaptureUnavailableException(string message) : InvalidOperationException(message);

// Capture d'une fenetre sans la mettre devant : PrintWindow(PW_RENDERFULLCONTENT), meme recouverte (pas reduite).
// Coordonnees physiques (fil en DPI par ecran v2), image recadree sur le cadre DWM (sans ombre invisible).
// Une application non adaptee au DPI se dessine a sa taille logique : bitmap a cette taille, agrandi ensuite a la
// taille affichee (sinon contenu a 80 % et bande noire, mesure NexusClaude). Image uniforme = vide : la session se
// replie alors sur la capture Sky (Windows.Graphics.Capture).
static class Capture
{
    const uint PW_RENDERFULLCONTENT = 2;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    static readonly nint PerMonitorAwareV2 = -4;

    public static object Window(nint hwnd, string directory)
    {
        if (!Path.IsPathFullyQualified(directory)) throw new InvalidOperationException("Capture directory must be absolute");
        foreach (var variable in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
        {
            var synced = Environment.GetEnvironmentVariable(variable);
            if (!string.IsNullOrEmpty(synced) && Path.GetFullPath(directory).StartsWith(Path.GetFullPath(synced).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Captures never go to a synced folder");
        }
        var timer = Stopwatch.StartNew();
        if (Win32.IsIconic(hwnd)) throw new CaptureUnavailableException("Window is minimized: nothing to draw");
        var previous = Win32.SetThreadDpiAwarenessContext(PerMonitorAwareV2);
        try
        {
            if (!Win32.GetWindowRect(hwnd, out var window) || window.Empty) throw new CaptureUnavailableException("Window has no size");
            var frame = Win32.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out var f, 16) == 0 && !f.Empty ? f : window;
            var scale = Scale(hwnd);
            int width = window.Width, height = window.Height;
            if (scale != 1.0) { width = Math.Max(1, (int)Math.Round(width / scale)); height = Math.Max(1, (int)Math.Round(height / scale)); }
            if ((long)width * height > 64L * 1024 * 1024) throw new CaptureUnavailableException("Window is too large to capture");
            var pixels = Print(hwnd, width, height);
            if (scale != 1.0) { pixels = Resize(pixels, width, height, window.Width, window.Height); width = window.Width; height = window.Height; }
            var crop = frame.Intersect(window);
            if (crop.Empty) crop = window;
            pixels = Crop(pixels, width, crop.Left - window.Left, crop.Top - window.Top, crop.Width, crop.Height);
            var (deviation, uniformity) = Statistics(pixels, crop.Width, crop.Height);
            var blank = deviation < 1.5;
            string? file = null;
            if (!blank)
            {
                Directory.CreateDirectory(directory);
                file = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".png");
                File.WriteAllBytes(file, Png(pixels, crop.Width, crop.Height));
            }
            var method = scale == 1.0 ? "printwindow" : "printwindow-dpi-scaled";
            return new
            {
                ok = true, method, path = file, width = crop.Width, height = crop.Height, scale, blank,
                deviation = Math.Round(deviation, 2), uniformity = Math.Round(uniformity, 3), ms = timer.ElapsedMilliseconds,
                frame = new { left = crop.Left, top = crop.Top, width = crop.Width, height = crop.Height },
            };
        }
        finally { Win32.SetThreadDpiAwarenessContext(previous); }
    }

    // Facteur entre la taille affichee (physique) et la taille dessinee par l'application.
    internal static double Scale(nint hwnd)
    {
        var awareness = Win32.GetAwarenessFromDpiAwarenessContext(Win32.GetWindowDpiAwarenessContext(hwnd));
        if (awareness >= 2) return 1.0; // par ecran : dessine en pixels physiques
        var monitor = Win32.MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
        if (Win32.GetDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, out var dpi, out _) != 0 || dpi == 0) return 1.0;
        // DPI de dessin de CETTE fenetre (96 si non adaptee, DPI systeme de son contexte sinon), jamais celui du processus :
        // un fil SYSTEM_AWARE d'un processus non adapte dessine a 120 (relecture de Codex du 22/10 07:59).
        double drawn = Win32.GetDpiForWindow(hwnd);
        if (drawn <= 0) return 1.0;
        var scale = dpi / drawn;
        return Math.Abs(scale - 1.0) < 0.01 ? 1.0 : scale;
    }

    static byte[] Print(nint hwnd, int width, int height)
    {
        var screen = Win32.GetDC(0);
        var dc = Win32.CreateCompatibleDC(screen);
        Win32.ReleaseDC(0, screen);
        if (dc == 0) throw new CaptureUnavailableException("No memory device context");
        try
        {
            var header = new Win32.BitmapInfoHeader { Size = 40, Width = width, Height = -height, Planes = 1, BitCount = 32 };
            var bitmap = Win32.CreateDIBSection(dc, ref header, 0, out var bits, 0, 0);
            if (bitmap == 0) throw new CaptureUnavailableException("CreateDIBSection failed");
            var old = Win32.SelectObject(dc, bitmap);
            try
            {
                if (!Win32.PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)) throw new CaptureUnavailableException("PrintWindow failed");
                Win32.GdiFlush();
                var pixels = new byte[width * height * 4];
                System.Runtime.InteropServices.Marshal.Copy(bits, pixels, 0, pixels.Length);
                return pixels;
            }
            finally { Win32.SelectObject(dc, old); Win32.DeleteObject(bitmap); }
        }
        finally { Win32.DeleteDC(dc); }
    }

    // Agrandissement bilineaire BGRA (application non adaptee au DPI).
    static byte[] Resize(byte[] source, int sw, int sh, int dw, int dh)
    {
        var result = new byte[dw * dh * 4];
        for (var y = 0; y < dh; y++)
        {
            var fy = Math.Max(0, (y + 0.5) * sh / dh - 0.5);
            int y0 = Math.Min((int)fy, sh - 1), y1 = Math.Min(y0 + 1, sh - 1);
            var wy = fy - y0;
            for (var x = 0; x < dw; x++)
            {
                var fx = Math.Max(0, (x + 0.5) * sw / dw - 0.5);
                int x0 = Math.Min((int)fx, sw - 1), x1 = Math.Min(x0 + 1, sw - 1);
                var wx = fx - x0;
                for (var c = 0; c < 4; c++)
                {
                    double a = source[(y0 * sw + x0) * 4 + c], b = source[(y0 * sw + x1) * 4 + c];
                    double d = source[(y1 * sw + x0) * 4 + c], e = source[(y1 * sw + x1) * 4 + c];
                    result[(y * dw + x) * 4 + c] = (byte)Math.Round((a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy);
                }
            }
        }
        return result;
    }

    static byte[] Crop(byte[] source, int sourceWidth, int left, int top, int width, int height)
    {
        if (left == 0 && top == 0 && width == sourceWidth && source.Length == width * height * 4) return source;
        var result = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
            Buffer.BlockCopy(source, ((top + y) * sourceWidth + left) * 4, result, y * width * 4, width * 4);
        return result;
    }

    // Ecart type de la luminance sur une grille de 64 x 64 points ; < 1,5 = image uniforme (noire, blanche ou vide).
    public static (double Deviation, double Uniformity) Statistics(byte[] bgra, int width, int height)
    {
        const int grid = 64;
        var histogram = new int[256];
        double sum = 0, squares = 0;
        var samples = 0;
        for (var gy = 0; gy < grid; gy++)
            for (var gx = 0; gx < grid; gx++)
            {
                var x = (int)((gx + 0.5) * width / grid);
                var y = (int)((gy + 0.5) * height / grid);
                var i = (Math.Min(y, height - 1) * width + Math.Min(x, width - 1)) * 4;
                var luminance = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2];
                sum += luminance; squares += luminance * luminance; samples++;
                histogram[(int)luminance]++;
            }
        var mean = sum / samples;
        return (Math.Sqrt(Math.Max(0, squares / samples - mean * mean)), histogram.Max() / (double)samples);
    }

    // PNG RVB 8 bits minimal (filtre 0, zlib) : aucune dependance d'imagerie.
    public static byte[] Png(byte[] bgra, int width, int height)
    {
        using var raw = new MemoryStream();
        using (var z = new ZLibStream(raw, CompressionLevel.Fastest, leaveOpen: true))
        {
            var row = new byte[1 + width * 3];
            for (var y = 0; y < height; y++)
            {
                row[0] = 0;
                for (var x = 0; x < width; x++)
                {
                    var i = (y * width + x) * 4;
                    row[1 + x * 3] = bgra[i + 2]; row[2 + x * 3] = bgra[i + 1]; row[3 + x * 3] = bgra[i];
                }
                z.Write(row);
            }
        }
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var header = new byte[13];
        WriteBig(header, 0, (uint)width); WriteBig(header, 4, (uint)height);
        header[8] = 8; header[9] = 2; // 8 bits, RVB
        Chunk(png, "IHDR", header);
        Chunk(png, "IDAT", raw.ToArray());
        Chunk(png, "IEND", []);
        return png.ToArray();
    }
    static void WriteBig(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24); buffer[offset + 1] = (byte)(value >> 16); buffer[offset + 2] = (byte)(value >> 8); buffer[offset + 3] = (byte)value;
    }
    static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();
    static void Chunk(Stream output, string type, byte[] data)
    {
        var length = new byte[4]; WriteBig(length, 0, (uint)data.Length);
        output.Write(length);
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes); output.Write(data);
        var crc = 0xFFFFFFFFu;
        foreach (var b in typeBytes) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        foreach (var b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        var tail = new byte[4]; WriteBig(tail, 0, crc ^ 0xFFFFFFFFu);
        output.Write(tail);
    }
}
