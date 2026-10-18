using System.IO;
using System.Text.Json;

// Blocage dur de la politique commune garde-fous.json (accord Claude–Antigravity du 18/10/2026, entree « codex ») :
// fenetres jamais lues ni pilotees. Chemin passe par la session (NEXUS_GARDE_FOUS, lib/native.mjs). Absent, illisible
// ou invalide : refus de toute requete sur une fenetre (echec ferme). Tout ce qui n'est pas bloque ici est libre :
// consoles, terminaux, Explorateur, outils d'administration.
static class GardeFous
{
    const string Agent = "codex";
    sealed record Rule(string Reason, HashSet<string> Processes, HashSet<string> Classes, string[] Prefixes);
    static (string Key, List<Rule> Rules)? cache;

    static List<Rule> Rules()
    {
        var file = Environment.GetEnvironmentVariable("NEXUS_GARDE_FOUS");
        if (string.IsNullOrEmpty(file)) throw new InvalidDataException("NEXUS_GARDE_FOUS is not set");
        var info = new FileInfo(file);
        if (!info.Exists) throw new FileNotFoundException("Policy file not found", file);
        var key = $"{info.FullName}:{info.LastWriteTimeUtc.Ticks}:{info.Length}";
        if (cache is { } c && c.Key == key) return c.Rules;
        using var json = JsonDocument.Parse(File.ReadAllText(file));
        var root = json.RootElement;
        var blocks = root.GetProperty("blocage_dur");
        var rules = new List<Rule>();
        foreach (var name in root.GetProperty("agents").GetProperty(Agent).EnumerateArray())
        {
            var block = blocks.GetProperty(name.GetString() ?? throw new InvalidDataException("Empty category"));
            HashSet<string> Set(string property) => block.TryGetProperty(property, out var v)
                ? v.EnumerateArray().Select(x => x.GetString() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase)
                : new(StringComparer.OrdinalIgnoreCase);
            var prefixes = block.TryGetProperty("prefixes_processus", out var p) ? p.EnumerateArray().Select(x => (x.GetString() ?? "").ToLowerInvariant()).ToArray() : [];
            rules.Add(new Rule(block.GetProperty("raison").GetString() ?? "", Set("processus"), Set("classes"), prefixes));
        }
        cache = (key, rules);
        return rules;
    }

    // Raison du blocage de cette fenetre (processus sans « .exe », classe de fenetre), null si elle est libre.
    public static string? BlockReason(string processName, string className)
    {
        List<Rule> rules;
        try { rules = Rules(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException or KeyNotFoundException or InvalidOperationException)
        {
            return $"Garde-fous policy unreadable ({error.Message}); nothing was sent (fail closed)";
        }
        var exe = processName.ToLowerInvariant() + ".exe";
        foreach (var rule in rules)
        {
            if (rule.Processes.Contains(exe) || (className.Length > 0 && rule.Classes.Contains(className)) || rule.Prefixes.Any(exe.StartsWith))
                return $"Blocked by the shared garde-fous policy: {rule.Reason}";
        }
        return null;
    }
}
