using System.Text.Json;

// Recherche d'un element de menu DIRECTEMENT sous un autre (relecture de Codex du 22/10), independante de la source de
// l'arbre (UI Automation dans ComUia.MenuChild, arbre simule dans --menu-selftest) : parcours en largeur qui traverse les
// conteneurs (menu, barre, volet) sans jamais franchir un autre element de menu ; nom exact, identifiant
// d'automatisation s'il est donne ; homonyme, plus de Max noeuds ou enfants illisibles (children leve) : refus.
static class MenuSearch
{
    public const int Max = 2000;

    public static (bool Found, T Item) Find<T>(T scope, Func<T, IReadOnlyList<T>> children, Func<T, bool> isMenuItem,
        Func<T, string> name, Func<T, string> automationId, string wantedName, string? wantedId)
    {
        var queue = new Queue<T>(children(scope));
        var visited = queue.Count;
        (bool, T) found = (false, default!);
        while (queue.Count > 0)
        {
            var node = queue.Dequeue();
            if (isMenuItem(node))
            {
                if (name(node) != wantedName || wantedId is { Length: > 0 } && automationId(node) != wantedId) continue;
                if (found.Item1) throw new BackgroundNotApplicableException($"Menu item « {wantedName} » is ambiguous at this level: nothing was sent");
                found = (true, node);
                continue; // jamais franchi
            }
            foreach (var child in children(node))
            {
                if (++visited > Max) throw new BackgroundNotApplicableException("Menu too large to be read completely: nothing was sent");
                queue.Enqueue(child);
            }
        }
        if (visited > Max) throw new BackgroundNotApplicableException("Menu too large to be read completely: nothing was sent");
        return found;
    }

    // Chemin d'un element de menu WinForms vise par un clic : elements de menu de son ascendance observee (dans l'ordre),
    // puis lui-meme (nom, identifiant d'automatisation du selecteur) ; un ancetre exige par le selecteur doit figurer dans
    // l'ascendance observee.
    public static (string Name, string? AutomationId)[] Segments(IReadOnlyList<JsonElement> ancestry, JsonElement selector)
    {
        static string Field(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        static bool Same(JsonElement e, JsonProperty p) => p.Name == "window"
            ? e.TryGetProperty("nativeWindow", out var w) && w.ValueKind == JsonValueKind.Number && w.GetInt64() == p.Value.GetInt64()
            : Field(e, p.Name) == p.Value.GetString();
        if (selector.TryGetProperty("ancestor", out var wanted) &&
            !ancestry.Any(e => wanted.EnumerateObject().Where(p => p.Name != "ancestor").All(p => Same(e, p))))
            throw new ActionRefusedException("Menu context changed (required ancestor absent); inspect again");
        return ancestry.Where(e => Field(e, "role") == "menuitem").Select(e => (Field(e, "name"), (string?)Field(e, "automationId")))
            .Append((Field(selector, "name"), selector.TryGetProperty("automationId", out var aid) ? aid.GetString() : null)).ToArray();
    }

    // Portee d'une commande de menu : la surgissante (menu contextuel ou deroulant ouvert) de son ascendance observee,
    // derniere fenetre propre differente de la fenetre suivie ; sinon la fenetre suivie. La surgissante doit encore etre
    // ouverte et liee (verifie par l'appelant, Win32.IsTransientPopup) : jamais une autre fenetre devinee.
    public static long Scope(long window, IReadOnlyList<JsonElement> ancestry) =>
        ancestry.Select(e => e.TryGetProperty("nativeWindow", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetInt64() : 0)
            .LastOrDefault(w => w != 0 && w != window) is var popup && popup != 0 ? popup : window;

    // Controle hors ligne (tests) : stdin = {"nodes": [{"id", "role", "name", "automationId", "children": [ids],
    // "unreadable"}], "root", "path": [{"name", "automationId"}]} ou {"ancestry", "selector"} ; sortie {"id"} / {"segments"}
    // ou {"error"}.
    public static int SelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var root = input.RootElement;
        object result;
        try
        {
            if (root.TryGetProperty("scopeOf", out var scopeOf))
                result = new { scope = Scope(scopeOf.GetInt64(), root.GetProperty("ancestry").EnumerateArray().ToList()) };
            else if (root.TryGetProperty("selector", out var selector))
            {
                var segments = Segments(root.GetProperty("ancestry").EnumerateArray().ToList(), selector);
                result = new { segments = segments.Select(s => new { name = s.Name, automationId = s.AutomationId }).ToArray() };
            }
            else
            {
                var nodes = root.GetProperty("nodes").EnumerateArray().ToDictionary(n => n.GetProperty("id").GetInt32());
                string F(int id, string key) => nodes[id].TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
                IReadOnlyList<int> Children(int id)
                {
                    if (nodes[id].TryGetProperty("unreadable", out var u) && u.GetBoolean()) throw new BackgroundNotApplicableException("Menu could not be read completely: nothing was sent");
                    return nodes[id].TryGetProperty("children", out var c) ? c.EnumerateArray().Select(x => x.GetInt32()).ToList() : [];
                }
                var scope = root.GetProperty("root").GetInt32();
                foreach (var segment in root.GetProperty("path").EnumerateArray())
                {
                    var (found, item) = Find(scope, Children, id => F(id, "role") == "menuitem", id => F(id, "name"), id => F(id, "automationId"),
                        segment.GetProperty("name").GetString()!, segment.TryGetProperty("automationId", out var a) ? a.GetString() : null);
                    if (!found) throw new BackgroundNotApplicableException($"Menu item « {segment.GetProperty("name").GetString()} » not found at this level");
                    scope = item;
                }
                result = new { id = scope };
            }
        }
        catch (Exception error) when (error is BackgroundNotApplicableException or ActionRefusedException) { result = new { error = error.Message }; }
        Console.WriteLine(JsonSerializer.Serialize(result));
        return 0;
    }
}
