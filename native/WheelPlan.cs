using System.Text.Json;

// Sens et quantite d'une molette au point (lib/session.mjs : deltaY = -120 x crans de scrollY, deltaX = +120 x crans de
// scrollX). Convention Windows : seul l'axe VERTICAL est inverse (cran vers le bas = delta negatif) ; a l'horizontale,
// delta positif = vers la droite (WM_MOUSEHWHEEL). Relecture de Codex du 21/10 : le sens horizontal etait inverse.
readonly record struct ScrollPlan(bool Vertical, bool Forward, int Notches)
{
    // ScrollAmount d'UI Automation : 4 = petite avance (vers la fin), 1 = petit retrait.
    public int Amount => Forward ? 4 : 1;

    public static ScrollPlan Of(int deltaY, int deltaX)
    {
        if ((deltaY == 0) == (deltaX == 0)) throw new BackgroundNotApplicableException("Semantic scroll needs exactly one axis");
        var vertical = deltaY != 0;
        var delta = vertical ? deltaY : deltaX;
        return new(vertical, vertical ? delta < 0 : delta > 0, Math.Clamp(Math.Abs(delta) / 120, 1, 50));
    }

    // Extremite REELLE seulement (relecture de Codex : 99,9 % d'un contenu de 100 000 px laisse encore 100 px).
    public bool AtEnd(double percent) => Forward ? percent >= 100 : percent <= 0;

    // DevTools : deltaY positif = vers le bas (l'inverse de Windows), deltaX positif = vers la droite (comme Windows).
    public static (int X, int Y) DevTools(int deltaY, int deltaX) => (deltaX, -deltaY);

    // Controle hors ligne (tests) : stdin = [{"deltaY", "deltaX", "percent"}] ; sortie un plan par cas, ou l'erreur.
    public static int SelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var results = new List<object>();
        foreach (var c in input.RootElement.EnumerateArray())
        {
            var (dy, dx) = (c.GetProperty("deltaY").GetInt32(), c.GetProperty("deltaX").GetInt32());
            var percent = c.TryGetProperty("percent", out var p) ? p.GetDouble() : 50;
            try
            {
                var plan = Of(dy, dx);
                var (cx, cy) = DevTools(dy, dx);
                results.Add(new { vertical = plan.Vertical, forward = plan.Forward, amount = plan.Amount, notches = plan.Notches, atEnd = plan.AtEnd(percent), cdpX = cx, cdpY = cy });
            }
            catch (BackgroundNotApplicableException error) { results.Add(new { error = error.Message }); }
        }
        Console.WriteLine(JsonSerializer.Serialize(results));
        return 0;
    }
}

// Choix du conteneur defilable parmi les candidats sous le point (relecture de Codex du 21/10) : la plus petite aire ;
// a aire egale, celui qui descend de tous les autres (le plus profond) ; sinon ambigu, refus. Recherche au-dela de Max
// elements : non exhaustive, refus.
static class ScrollChoice
{
    public const int Max = 5000;

    public static void CheckCount(int count)
    {
        if (count > Max) throw new BackgroundNotApplicableException($"More than {Max} scrollable elements: search not exhaustive, nothing was sent");
    }

    // Index choisi, ou -1 sans candidat. isDescendant(a, b) : a descend strictement de b.
    public static int Pick(IReadOnlyList<long> areas, Func<int, int, bool> isDescendant)
    {
        if (areas.Count == 0) return -1;
        var min = areas.Min();
        var tied = Enumerable.Range(0, areas.Count).Where(i => areas[i] == min).ToList();
        var deepest = tied.Where(i => tied.All(j => j == i || isDescendant(i, j))).ToList();
        if (deepest.Count == 1) return deepest[0];
        throw new BackgroundNotApplicableException("Several scrollable containers of the same size under the point, not nested: ambiguous, nothing was sent");
    }

    // Controle hors ligne (tests) : stdin = {"count", "areas", "parents": {"i": parent}} ; sortie {"index"} ou {"error"}.
    public static int SelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var root = input.RootElement;
        var parents = root.TryGetProperty("parents", out var map) ? map.EnumerateObject().ToDictionary(e => int.Parse(e.Name), e => e.Value.GetInt32()) : new();
        bool Descends(int a, int b)
        {
            for (var hops = 0; hops < 64 && parents.TryGetValue(a, out var p); hops++) { if (p == b) return true; a = p; }
            return false;
        }
        object result;
        try
        {
            CheckCount(root.GetProperty("count").GetInt32());
            result = new { index = Pick(root.GetProperty("areas").EnumerateArray().Select(a => a.GetInt64()).ToList(), Descends) };
        }
        catch (BackgroundNotApplicableException error) { result = new { error = error.Message }; }
        Console.WriteLine(JsonSerializer.Serialize(result));
        return 0;
    }
}
