using System.IO;

// WebP SANS PERTE (VP8L) minimal, sans dependance d'imagerie (Windows ne fournit pas d'encodeur WebP : WIC ne fait que le
// decoder). Specification : https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
// Transformations : soustraction du vert puis prediction par blocs de 32 px (gauche ou haut, le moins couteux par bloc) ;
// image principale en un seul groupe de codes, references arriere LZ77 (gloutonnes, table de hachage) et codes de
// Huffman canoniques limites a 15 bits (longueurs des codes ecrites sans codes de repetition). Verifie pixel par pixel
// contre le decodeur de reference (libwebp, tests).
static class WebP
{
    sealed class BitWriter
    {
        readonly MemoryStream stream = new();
        ulong bits;
        int used;
        public void Put(uint value, int count)
        {
            if (count == 0) return;
            bits |= (ulong)(value & ((1u << count) - 1)) << used;
            used += count;
            while (used >= 8) { stream.WriteByte((byte)bits); bits >>= 8; used -= 8; }
        }
        public byte[] Finish()
        {
            if (used > 0) stream.WriteByte((byte)bits);
            bits = 0; used = 0;
            return stream.ToArray();
        }
    }

    const int NumLengthCodes = 24, NumDistanceCodes = 40, MaxLength = 4096, MinMatch = 3, BlockBits = 5;
    const int MaxDistance = (1 << 20) - 121; // 40 codes de distance : valeur ecrite (distance + 120) < 2^20
    static readonly int[] CodeLengthOrder = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    // Valeur >= 1 → (code de prefixe, nombre de bits en plus, bits en plus) du schema LZ77 de VP8L.
    static (int Code, int ExtraBits, int Extra) Prefix(int value)
    {
        var d = value - 1;
        if (d < 4) return (d, 0, 0);
        var high = 31 - System.Numerics.BitOperations.LeadingZeroCount((uint)d);
        var second = (d >> (high - 1)) & 1;
        var extraBits = high - 1;
        return (2 * high + second, extraBits, d & ((1 << extraBits) - 1));
    }

    // Longueurs de Huffman limitees a `limit` bits ; frequences aplaties tant que la limite est depassee.
    static int[] Lengths(long[] freq, int limit)
    {
        var n = freq.Length;
        var lengths = new int[n];
        var used = Enumerable.Range(0, n).Where(i => freq[i] > 0).ToList();
        if (used.Count == 0) return lengths;
        if (used.Count == 1) { lengths[used[0]] = 1; return lengths; }
        var f = (long[])freq.Clone();
        while (true)
        {
            var heap = new PriorityQueue<int, long>();
            var parent = new List<int>();
            var weight = new List<long>();
            foreach (var i in used) { heap.Enqueue(parent.Count, f[i]); parent.Add(-1); weight.Add(f[i]); }
            while (heap.Count > 1)
            {
                heap.TryDequeue(out var a, out var wa);
                heap.TryDequeue(out var b, out var wb);
                var node = parent.Count;
                parent.Add(-1); weight.Add(wa + wb);
                parent[a] = node; parent[b] = node;
                heap.Enqueue(node, wa + wb);
            }
            var max = 0;
            for (var k = 0; k < used.Count; k++)
            {
                var depth = 0;
                for (var p = k; parent[p] >= 0; p = parent[p]) depth++;
                lengths[used[k]] = depth;
                max = Math.Max(max, depth);
            }
            if (max <= limit) return lengths;
            foreach (var i in used) f[i] = Math.Max(1, (f[i] + 1) / 2);
        }
    }

    // Codes canoniques (comme deflate), bits inverses pour l'ecriture du bit de poids faible d'abord.
    static uint[] Codes(int[] lengths)
    {
        var codes = new uint[lengths.Length];
        var count = new int[16];
        foreach (var l in lengths) if (l > 0) count[l]++;
        var next = new int[16];
        var code = 0;
        for (var bitsLen = 1; bitsLen <= 15; bitsLen++) { code = (code + count[bitsLen - 1]) << 1; next[bitsLen] = code; }
        for (var s = 0; s < lengths.Length; s++)
        {
            var l = lengths[s];
            if (l == 0) continue;
            var c = (uint)next[l]++;
            uint reversed = 0;
            for (var i = 0; i < l; i++) reversed |= ((c >> i) & 1) << (l - 1 - i);
            codes[s] = reversed;
        }
        return codes;
    }

    // Un code a un seul symbole se lit en zero bit (libwebp : « special case code with only one value ») : rien n'est
    // ecrit pour lui.
    sealed class Code(int[] lengths, uint[] codes)
    {
        public readonly int[] Lengths = lengths;
        public readonly uint[] Codes = codes;
        readonly bool single = lengths.Count(l => l > 0) <= 1;
        public void Put(BitWriter w, int symbol) { if (!single) w.Put(Codes[symbol], Lengths[symbol]); }
    }

    // Ecrit un code de prefixe et le rend : simple (un symbole < 256, zero bit par symbole), sinon normal.
    static Code WriteCode(BitWriter w, long[] freq)
    {
        var used = Enumerable.Range(0, freq.Length).Where(i => freq[i] > 0).ToList();
        if (used.Count <= 1 && (used.Count == 0 || used[0] < 256))
        {
            var symbol = used.Count == 0 ? 0 : used[0];
            w.Put(1, 1); // code simple
            w.Put(0, 1); // un symbole
            if (symbol < 2) { w.Put(0, 1); w.Put((uint)symbol, 1); }
            else { w.Put(1, 1); w.Put((uint)symbol, 8); }
            return new Code(new int[freq.Length], new uint[freq.Length]);
        }
        var lengths = Lengths(freq, 15);
        if (used.Count == 1) { lengths[used[0]] = 1; }
        // Code des longueurs : symboles 0..15, longueurs limitees a 7 bits.
        var clFreq = new long[19];
        foreach (var l in lengths) clFreq[l]++;
        var clLengths = Lengths(clFreq, 7);
        if (clFreq.Count(c => c > 0) == 1) clLengths[Array.FindIndex(clFreq, c => c > 0)] = 1;
        var clCode = new Code(clLengths, Codes(clLengths));
        var numCodes = 19;
        while (numCodes > 4 && clLengths[CodeLengthOrder[numCodes - 1]] == 0) numCodes--;
        w.Put(0, 1); // code normal
        w.Put((uint)(numCodes - 4), 4);
        for (var i = 0; i < numCodes; i++) w.Put((uint)clLengths[CodeLengthOrder[i]], 3);
        w.Put(0, 1); // max_symbol absent : tous les symboles
        foreach (var l in lengths) clCode.Put(w, l);
        return new Code(lengths, Codes(lengths));
    }

    readonly record struct Token(int Literal, int Length, int Distance); // Length 0 : pixel litteral

    // Image entropique : codes ecrits puis jetons. `meta` : bit des codes meta (image principale seulement).
    static void WriteImage(BitWriter w, uint[] argb, int width, bool main)
    {
        var tokens = Tokens(argb, width);
        w.Put(0, 1); // pas de cache de couleurs
        if (main) w.Put(0, 1); // un seul groupe de codes
        var green = new long[256 + NumLengthCodes];
        var red = new long[256];
        var blue = new long[256];
        var alpha = new long[256];
        var dist = new long[NumDistanceCodes];
        foreach (var t in tokens)
        {
            if (t.Length == 0)
            {
                var p = (uint)t.Literal;
                green[(p >> 8) & 0xFF]++; red[(p >> 16) & 0xFF]++; blue[p & 0xFF]++; alpha[p >> 24]++;
            }
            else
            {
                green[256 + Prefix(t.Length).Code]++;
                dist[Prefix(t.Distance + 120).Code]++;
            }
        }
        var g = WriteCode(w, green);
        var r = WriteCode(w, red);
        var b = WriteCode(w, blue);
        var a = WriteCode(w, alpha);
        var d = WriteCode(w, dist);
        foreach (var t in tokens)
        {
            if (t.Length == 0)
            {
                var p = (uint)t.Literal;
                g.Put(w, (int)((p >> 8) & 0xFF)); r.Put(w, (int)((p >> 16) & 0xFF)); b.Put(w, (int)(p & 0xFF)); a.Put(w, (int)(p >> 24));
            }
            else
            {
                var (lc, lb, le) = Prefix(t.Length);
                g.Put(w, 256 + lc); w.Put((uint)le, lb);
                var (dc, db, de) = Prefix(t.Distance + 120);
                d.Put(w, dc); w.Put((uint)de, db);
            }
        }
    }

    // LZ77 glouton : correspondance la plus longue parmi la distance 1 (gauche), la ligne du dessus et la derniere
    // occurrence du meme triplet (table de hachage).
    static List<Token> Tokens(uint[] p, int width)
    {
        var tokens = new List<Token>();
        var n = p.Length;
        var table = new Dictionary<ulong, int>();
        int Match(int at, int from)
        {
            if (from < 0 || from >= at || at - from > MaxDistance) return 0;
            var len = 0;
            while (at + len < n && len < MaxLength && p[from + len] == p[at + len]) len++;
            return len;
        }
        var i = 0;
        while (i < n)
        {
            int bestLen = 0, bestDist = 0;
            foreach (var cand in new[] { i - 1, i - width })
            {
                var len = Match(i, cand);
                if (len > bestLen) { bestLen = len; bestDist = i - cand; }
            }
            ulong key = 0;
            if (i + 2 < n)
            {
                key = ((ulong)p[i] * 0x9E3779B97F4A7C15UL) ^ ((ulong)p[i + 1] << 21) ^ ((ulong)p[i + 2] * 0xC2B2AE3D27D4EB4FUL);
                if (table.TryGetValue(key, out var prev))
                {
                    var len = Match(i, prev);
                    if (len > bestLen) { bestLen = len; bestDist = i - prev; }
                }
            }
            if (bestLen >= MinMatch)
            {
                tokens.Add(new Token(0, bestLen, bestDist));
                for (var k = 0; k < bestLen; k += 16)
                    if (i + k + 2 < n) table[((ulong)p[i + k] * 0x9E3779B97F4A7C15UL) ^ ((ulong)p[i + k + 1] << 21) ^ ((ulong)p[i + k + 2] * 0xC2B2AE3D27D4EB4FUL)] = i + k;
                i += bestLen;
            }
            else
            {
                tokens.Add(new Token((int)p[i], 0, 0));
                if (i + 2 < n) table[key] = i;
                i++;
            }
        }
        return tokens;
    }

    static uint Sub(uint a, uint b) =>
        (((a >> 24) - (b >> 24)) & 0xFF) << 24 | (((a >> 16) - (b >> 16)) & 0xFF) << 16 |
        (((a >> 8) - (b >> 8)) & 0xFF) << 8 | ((a - b) & 0xFF);

    static int Cost(uint residual)
    {
        int c(uint v) { var x = (int)(v & 0xFF); return x > 127 ? 256 - x : x; }
        return c(residual) + c(residual >> 8) + c(residual >> 16) + c(residual >> 24);
    }

    // BGRA (capture) → WebP sans perte. `alpha` : la capture est opaque, l'alpha ecrit est 255.
    public static byte[] Lossless(byte[] bgra, int width, int height)
    {
        if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new ArgumentOutOfRangeException(nameof(width));
        var n = width * height;
        var argb = new uint[n];
        for (var i = 0; i < n; i++)
        {
            uint b = bgra[i * 4], g = bgra[i * 4 + 1], r = bgra[i * 4 + 2];
            // soustraction du vert
            argb[i] = 0xFF000000u | (((r - g) & 0xFF) << 16) | (g << 8) | ((b - g) & 0xFF);
        }
        // Prediction par blocs : mode 1 (gauche) ou 2 (haut), le moins couteux ; bords imposes par la specification.
        var block = 1 << BlockBits;
        int bw = (width + block - 1) >> BlockBits, bh = (height + block - 1) >> BlockBits;
        var modes = new int[bw * bh];
        for (var by = 0; by < bh; by++)
            for (var bx = 0; bx < bw; bx++)
            {
                long left = 0, top = 0;
                for (var y = by * block; y < Math.Min(height, (by + 1) * block); y++)
                    for (var x = bx * block; x < Math.Min(width, (bx + 1) * block); x++)
                    {
                        var i = y * width + x;
                        if (x > 0) left += Cost(Sub(argb[i], argb[i - 1]));
                        if (y > 0) top += Cost(Sub(argb[i], argb[i - width]));
                    }
                modes[by * bw + bx] = top < left ? 2 : 1;
            }
        var residual = new uint[n];
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var i = y * width + x;
                uint pred;
                if (x == 0 && y == 0) pred = 0xFF000000u;
                else if (y == 0) pred = argb[i - 1];
                else if (x == 0) pred = argb[i - width];
                else pred = modes[(y >> BlockBits) * bw + (x >> BlockBits)] == 2 ? argb[i - width] : argb[i - 1];
                residual[i] = Sub(argb[i], pred);
            }
        var w = new BitWriter();
        w.Put(0x2F, 8);
        w.Put((uint)(width - 1), 14);
        w.Put((uint)(height - 1), 14);
        w.Put(0, 1); // alpha non utilise
        w.Put(0, 3); // version 0
        // Transformations, dans l'ordre d'application : soustraction du vert, puis prediction.
        w.Put(1, 1); w.Put(2, 2); // SUBTRACT_GREEN
        w.Put(1, 1); w.Put(0, 2); // PREDICTOR
        w.Put(BlockBits - 2, 3);
        var predictorImage = modes.Select(m => 0xFF000000u | ((uint)m << 8)).ToArray();
        WriteImage(w, predictorImage, bw, main: false);
        w.Put(0, 1); // fin des transformations
        WriteImage(w, residual, width, main: true);
        var data = w.Finish();
        using var file = new MemoryStream();
        void Ascii(string s) => file.Write(System.Text.Encoding.ASCII.GetBytes(s));
        void U32(int v) => file.Write(BitConverter.GetBytes(v));
        var padded = data.Length + (data.Length & 1);
        Ascii("RIFF"); U32(4 + 8 + padded); Ascii("WEBP"); Ascii("VP8L"); U32(data.Length);
        file.Write(data);
        if ((data.Length & 1) != 0) file.WriteByte(0);
        return file.ToArray();
    }
}
