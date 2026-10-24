// Numeros [N] sur l'image envoyee au modele (regle commune des produits Nexus, shared/images.md point 5 ; avis de Codex
// du 24/10) : chaque etiquette porte l'index EXACT de la ligne de l'arbre lu juste avant la capture (jamais renumerote),
// dessinee APRES la reduction et avant l'encodage, a taille constante dans l'image finale (police 5x7 maison, x2), avec un
// trait d'un pixel autour de l'element. Statistics (image vide) est calcule avant : une etiquette ne rend jamais
// « valide » un PrintWindow vide. Placement deterministe (ordre des index), collisions evitees, au plus MaxDrawn.
sealed record Mark(int Index, int Left, int Top, int Width, int Height, long Scope);

sealed class MarkReport
{
    public List<int> Drawn { get; } = [];
    public List<int> Omitted { get; } = []; // place prise par d'autres etiquettes, ou plafond atteint
    public int Outside { get; set; } // hors de la zone capturee (zoom, defilement)
    public List<int> Foreign { get; } = []; // element d'une autre fenetre (menu surgissant absent du PrintWindow)
    public string? Reason { get; set; } // aucune marque, et pourquoi
    public object Json() => new { drawn = Drawn, omitted = Omitted, outside = Outside, foreign = Foreign, reason = Reason };
}

static class Marks
{
    const int MaxDrawn = 120;
    const int Dot = 2, Gap = 2, Pad = 2;
    static readonly byte[] Back = [0x30, 0x10, 0xC0, 0xFF]; // BGRA : rouge sombre
    static readonly byte[] Ink = [0xFF, 0xFF, 0xFF, 0xFF];

    static readonly string[] Font =
    [
        "01110100011001110101110011000101110", "00100011000010000100001000010001110", "01110100010000100010001000100011111",
        "11111000100010000010000011000101110", "00010001100101010010111110001000010", "11111100001111000001000011000101110",
        "00110010001000011110100011000101110", "11111000010001000100010000100001000", "01110100011000101110100011000101110",
        "01110100011000101111000010001001100",
    ];

    // Elements gardes : ceux de cette fenetre (portee 0 = sans HWND propre, sous la racine lue) ou d'une fenetre enfant.
    public static List<Mark> Scoped(nint hwnd, IEnumerable<Mark> marks, MarkReport report)
    {
        var kept = new List<Mark>();
        foreach (var m in marks)
        {
            if (m.Scope == 0 || m.Scope == hwnd || IsChild(hwnd, (nint)m.Scope)) kept.Add(m);
            else report.Foreign.Add(m.Index);
        }
        return kept;
    }

    // pixels : image finale BGRA w x h ; frame : zone ECRAN qu'elle represente (pixels physiques).
    public static byte[] Draw(byte[] pixels, int w, int h, Win32.Rect frame, IReadOnlyList<Mark> marks, MarkReport report)
    {
        report.Drawn.Clear(); report.Omitted.Clear(); report.Outside = 0;
        var image = (byte[])pixels.Clone();
        double sx = (double)w / frame.Width, sy = (double)h / frame.Height;
        var placed = new List<(int L, int T, int R, int B)>();
        var labels = new List<(int Index, int X, int Y)>();
        foreach (var m in marks.OrderBy(m => m.Index))
        {
            int x0 = (int)Math.Floor((m.Left - frame.Left) * sx), y0 = (int)Math.Floor((m.Top - frame.Top) * sy);
            int x1 = (int)Math.Ceiling((m.Left + m.Width - frame.Left) * sx) - 1, y1 = (int)Math.Ceiling((m.Top + m.Height - frame.Top) * sy) - 1;
            x0 = Math.Max(0, x0); y0 = Math.Max(0, y0); x1 = Math.Min(w - 1, x1); y1 = Math.Min(h - 1, y1);
            if (x1 < x0 || y1 < y0) { report.Outside++; continue; }
            if (labels.Count >= MaxDrawn) { report.Omitted.Add(m.Index); continue; }
            var digits = m.Index.ToString(System.Globalization.CultureInfo.InvariantCulture);
            int lw = digits.Length * 5 * Dot + (digits.Length - 1) * Gap + 2 * Pad, lh = 7 * Dot + 2 * Pad;
            // Cartouche entier ou rien : tronque, « 12 » se lirait « 1 » (relecture de Codex du 24/10).
            if (lw > w || lh > h) { report.Omitted.Add(m.Index); continue; }
            (int X, int Y)? spot = null;
            foreach (var (cx, cy) in new[] { (x0, y0), (x0, y0 - lh), (x1 - lw + 1, y0), (x0, y1 - lh + 1) })
            {
                int lx = Math.Clamp(cx, 0, Math.Max(0, w - lw)), ly = Math.Clamp(cy, 0, Math.Max(0, h - lh));
                if (placed.Any(p => lx < p.R && p.L < lx + lw && ly < p.B && p.T < ly + lh)) continue;
                spot = (lx, ly); break;
            }
            if (spot is not { } s) { report.Omitted.Add(m.Index); continue; }
            placed.Add((s.X, s.Y, s.X + lw, s.Y + lh));
            labels.Add((m.Index, s.X, s.Y));
            Outline(image, w, x0, y0, x1, y1);
            report.Drawn.Add(m.Index);
        }
        foreach (var (index, x, y) in labels) Label(image, w, h, x, y, index.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return image;
    }

    static void Outline(byte[] image, int w, int x0, int y0, int x1, int y1)
    {
        for (var x = x0; x <= x1; x++) { Put(image, w, x, y0, Back); Put(image, w, x, y1, Back); }
        for (var y = y0; y <= y1; y++) { Put(image, w, x0, y, Back); Put(image, w, x1, y, Back); }
    }

    static void Label(byte[] image, int w, int h, int x, int y, string digits)
    {
        int lw = digits.Length * 5 * Dot + (digits.Length - 1) * Gap + 2 * Pad, lh = 7 * Dot + 2 * Pad;
        for (var yy = y; yy < Math.Min(h, y + lh); yy++)
            for (var xx = x; xx < Math.Min(w, x + lw); xx++) Put(image, w, xx, yy, Back);
        for (var d = 0; d < digits.Length; d++)
        {
            var glyph = Font[digits[d] - '0'];
            var gx = x + Pad + d * (5 * Dot + Gap);
            for (var row = 0; row < 7; row++)
                for (var col = 0; col < 5; col++)
                {
                    if (glyph[row * 5 + col] != '1') continue;
                    for (var dy = 0; dy < Dot; dy++)
                        for (var dx = 0; dx < Dot; dx++)
                        {
                            int px = gx + col * Dot + dx, py = y + Pad + row * Dot + dy;
                            if (px < w && py < h) Put(image, w, px, py, Ink);
                        }
                }
        }
    }

    static void Put(byte[] image, int w, int x, int y, byte[] color) => Buffer.BlockCopy(color, 0, image, (y * w + x) * 4, 4);

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsChild(nint parent, nint child);
}
