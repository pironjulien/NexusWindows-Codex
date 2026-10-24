using System.Diagnostics;

// Chromium (Chrome, Edge, Electron) en arriere-plan, recette COMMUNE des trois NexusWindows (banc du 21/10 ; NexusClaude
// act_chromium._select_by_typing / _sim_focus, NexusAGY _chromium_simulated_typing) : Chromium ne lit le clavier que
// fenetre active, et la liste d'un <select> ne s'ouvre pas en arriere-plan (« Option did not appear after expanding »).
// Activation SIMULEE : WM_NCACTIVATE puis WM_ACTIVATE envoyes a la fenetre de premier niveau (elle se croit active sans
// l'etre, premier plan de Julien intact), focus DOM par MSAA accSelect (relu), caracteres par WM_CHAR, effet relu ;
// desactivation POSTEE en sortie (traitee apres les caracteres encore en file), toute activation potentielle comprise.
// Sous le jeton de premier plan commun, dans une echeance bornee (Budget apres le jeton : le delai Node couvre jeton,
// voie complete et nettoyage). Premiere fois pour un processus : son droit de premier plan de lancement a pu servir
// (premier plan pris puis rendu, rapporte) et Chromium a recu une vraie desactivation : activation renvoyee et focus
// repris avant toute frappe. Frappe par UNITES bornees : focus de la cible relu avant chacune, valeur relue apres chacune
// (rien ne part tant que ce qui precede n'est pas relu ; jamais de delai arbitraire). Comparaisons EXACTES (fins de ligne
// seules normalisees). Avant le premier caractere, tout echec = non applicable ; apres, issue inconnue (arret d'urgence
// compris, dit « after input »), jamais rejouee. Fenetre deja au premier plan : voie non applicable, les techniques
// habituelles s'appliquent (Background.cs).
// Echec apres au moins un caractere envoye : issue inconnue (jamais convertie en « non applicable »).
sealed class AfterInputException(string message, Exception inner) : InvalidOperationException(message, inner);

static class ChromiumInput
{
    const uint WM_ACTIVATE = 0x0006, WM_NCACTIVATE = 0x0086, WM_CHAR = 0x0102;
    public const int Budget = 9000, Unit = 8, FirstSettleMs = 150;
    static readonly HashSet<uint> Primed = new();

    public readonly record struct Result(Outcome Outcome, bool Taken, string? GiveBack);

    public static bool IsChromium(nint window) => Win32.ClassName(Top(window)).StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
    public static bool InForeground(nint window) => Top(Win32.GetForegroundWindow()) == Top(window);
    static nint Top(nint window) => Win32.GetAncestor(window, Win32.GA_ROOT) is var root && root != 0 ? root : window;

    // Clic sur une surface editable Chromium : focus sans activation, relu.
    // started : appele juste avant le premier message d'activation (RunAction : « entree partie » a partir de la seulement).
    public static Result Focus(nint window, Node target, int? quietMs, Action? started = null) =>
        Run(window, target, quietMs, "focus", started, (_, _) => new("background:simulated-activation", "accSelect focus (simulated activation)", "applied"));

    // <select> Chromium : focus puis frappe du libelle (une unite) ; la recherche au clavier choisit l'option.
    public static Result Select(nint window, Node target, string option, int? quietMs, Action? started = null)
    {
        if (option.Length == 0 || option.Length > 64) throw new BackgroundNotApplicableException("Option label must be 1 to 64 characters to be typed");
        return Run(window, target, quietMs, "select", started, (top, deadline) =>
            TypeUnits(window, target, top, option, deadline, [option], _ => null, value => Same(value, option), "option typed"));
    }

    // Texte ajoute en fin d'un champ ou editeur riche Chromium (caret place en fin, relu unite par unite).
    public static Result Type(nint window, Node target, string text, int? quietMs, Action? started = null)
    {
        if (text.Length == 0) throw new BackgroundNotApplicableException("Nothing to type");
        if (text.Contains('\n') || text.Contains('\r')) throw new BackgroundNotApplicableException("Line breaks are typed by the physical fallback (Chromium inserts them only from the key)");
        return Run(window, target, quietMs, "type", started, (top, deadline) =>
        {
            var before = ReadValue(window, target, deadline) ?? throw new BackgroundNotApplicableException("Field value unreadable: nothing was typed");
            Call(new { op = "caretToEnd", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow }, deadline);
            var units = Units(text);
            return TypeUnits(window, target, top, text, deadline, units, typed => before + typed, value => Same(value, before + text), "text typed at the end");
        });
    }

    // Egalite exacte, fins de ligne seules normalisees (relecture de Codex du 22/10 : casse et espaces comptent).
    public static bool Same(string? actual, string expected) => actual is not null && actual.Replace("\r\n", "\n") == expected.Replace("\r\n", "\n");

    // Unites de frappe : au plus Unit unites UTF-16, sans couper une paire de substitution.
    public static List<string> Units(string text)
    {
        var units = new List<string>();
        for (var i = 0; i < text.Length;)
        {
            var length = Math.Min(Unit, text.Length - i);
            if (i + length < text.Length && char.IsHighSurrogate(text[i + length - 1])) length--;
            units.Add(text.Substring(i, length));
            i += length;
        }
        return units;
    }

    // Controle hors ligne (tests) : stdin = {"units": texte} ou {"same": [reel, attendu]}.
    public static int SelfTest()
    {
        using var input = System.Text.Json.JsonDocument.Parse(Console.In.ReadToEnd());
        var root = input.RootElement;
        object result = root.TryGetProperty("units", out var u) ? Units(u.GetString()!)
            : Same(root.GetProperty("same")[0].GetString(), root.GetProperty("same")[1].GetString()!);
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(result));
        return 0;
    }

    static int Remaining(long deadline) => (int)Math.Max(0, deadline - Environment.TickCount64);
    static Outcome Call(object request, long deadline)
    {
        var left = Remaining(deadline);
        if (left <= 0) throw new TimeoutException("Chromium input budget exhausted");
        return ComBridge.Call(request, Math.Min(left, ComBridge.TimeoutMs));
    }

    static string? ReadValue(nint window, Node target, long deadline)
    {
        Call(new { op = "flush", windowId = (long)window, runtimeId = Array.Empty<int>() }, deadline);
        using var tree = ComUia.Shared.ReadIdentity(window, target.RuntimeId, target.NativeWindow);
        return tree.Nodes.Count > 0 ? tree.Nodes[^1].Value : null;
    }

    // `expectedSoFar(typed)` : valeur attendue apres les unites deja envoyees (null : relecture seulement a la fin).
    static Outcome TypeUnits(nint window, Node target, nint top, string text, long deadline, List<string> units,
        Func<string, string?> expectedSoFar, Func<string?, bool> done, string what)
    {
        var sent = 0;
        var typed = "";
        string Partial() => $"{sent} of {text.Length} characters sent";
        try
        {
            foreach (var unit in units)
            {
                EmergencyStop.ThrowIfStopped();
                if (Top(Win32.GetForegroundWindow()) == top)
                    throw sent == 0 ? new BackgroundNotApplicableException("Julien switched to the window: nothing was typed")
                        : new InvalidOperationException("Julien switched to the window while typing: typing stopped");
                var focus = Call(new { op = "hasFocus", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow }, deadline);
                if (focus.Effect != "applied")
                    throw sent == 0 ? new BackgroundNotApplicableException("The field lost the focus: nothing was typed")
                        : new InvalidOperationException("The field lost the focus while typing: typing stopped");
                foreach (var ch in unit) { Win32.Post(top, WM_CHAR, ch, 1); sent++; }
                typed += unit;
                if (expectedSoFar(typed) is not { } expected || typed.Length == text.Length) continue;
                // Rien ne part tant que cette unite n'est pas relue (sans delai arbitraire : echeance seulement).
                while (!Same(ReadValue(window, target, deadline), expected))
                {
                    if (Remaining(deadline) <= 0) throw new InvalidOperationException("Typed unit not read back in time: typing stopped");
                    Thread.Sleep(20);
                }
            }
            while (Remaining(deadline) > 0)
            {
                if (done(ReadValue(window, target, deadline))) return new("background:simulated-activation", $"WM_CHAR {sent} ({what}, simulated activation)", "applied");
                Thread.Sleep(20);
            }
            return new("background:simulated-activation", $"WM_CHAR {sent} ({what}, simulated activation)", "sent");
        }
        catch (EmergencyStopException) when (sent > 0)
        {
            // Arret d'urgence apres des caracteres (frappe ou relecture) : etat partiel, jamais « rien n'a ete envoye ».
            throw new EmergencyStopException($"Emergency stop after input: {Partial()}; outcome unknown, do not replay");
        }
        catch (Exception error) when (sent > 0 && error is not EmergencyStopException)
        {
            throw new AfterInputException($"Typing interrupted after input: {Partial()}; outcome unknown, do not replay: {error.Message}", error);
        }
    }

    static Result Run(nint window, Node target, int? quietMs, string purpose, Action? started, Func<nint, long, Outcome> act)
    {
        var top = Top(window);
        if (!Win32.ClassName(top).StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal))
            throw new BackgroundNotApplicableException("Not a top-level Chromium window: simulated activation not applicable");
        if (Top(Win32.GetForegroundWindow()) == top)
            throw new BackgroundNotApplicableException("The window is in the foreground: simulated activation not needed");
        using var token = ForegroundToken.Acquire("Chromium simulated activation (" + purpose + ")");
        var deadline = Environment.TickCount64 + Budget;
        JulienPause.ThrowIfActive(quietMs);
        EmergencyStop.ThrowIfStopped();
        var noted = Win32.GetForegroundWindow();
        var input = Win32.Probe().LastInput;
        var pid = Win32.ProcessOf(top);
        var first = !Primed.Contains(pid);
        var taken = false;
        string? giveBack = null;
        var activated = false; // aucun message d'activation avant : rien a defaire en sortie
        try
        {
            started?.Invoke();
            activated = true; // preconditions, jeton, pause et STOP passes : le premier message d'activation part
            Activate(top);
            Focus(window, target, deadline);
            if (first)
            {
                // Premiere activation simulee de ce processus : son droit de premier plan de lancement a pu servir pendant
                // le focus. Premier plan rendu a Julien, puis activation renvoyee et focus repris ; rien n'est encore tape.
                Thread.Sleep(FirstSettleMs);
                if (Top(Win32.GetForegroundWindow()) == top)
                {
                    taken = true;
                    giveBack = ForegroundReturn.GiveBack(noted, window, input);
                    if (giveBack != "restored") throw new BackgroundNotApplicableException($"First activation took the foreground ({giveBack}): nothing was typed");
                    Activate(top);
                    Focus(window, target, deadline);
                }
                Primed.Add(pid);
            }
            if (Top(Win32.GetForegroundWindow()) == top)
                throw new BackgroundNotApplicableException("Julien switched to the window: nothing was typed");
            return new(act(top, deadline), taken, giveBack);
        }
        catch (Exception error) when (error is not (BackgroundNotApplicableException or EmergencyStopException or ActionRefusedException or JulienActiveException or AfterInputException))
        {
            // Avant le premier caractere (focus, delai, lecture) : rien n'a ete tape.
            throw new BackgroundNotApplicableException($"Chromium input impossible before typing ({error.GetType().Name}: {error.Message}): nothing was typed");
        }
        finally
        {
            if (!activated) { }
            else if (Top(Win32.GetForegroundWindow()) != top)
            {
                try { Win32.Post(top, WM_ACTIVATE, 0 /* WA_INACTIVE */, 0); Win32.Post(top, WM_NCACTIVATE, 0, 0); } catch (InvalidOperationException) { }
                Thread.Sleep(30);
            }
            else if (Win32.Probe().LastInput == input)
            {
                taken = true;
                giveBack = ForegroundReturn.GiveBack(noted, window, input);
            }
            LastTaken = taken;
            LastGiveBack = giveBack;
        }
    }

    // Prise et restitution du premier plan de la derniere voie (lues par RunAction, y compris apres une erreur).
    [ThreadStatic] public static bool LastTaken;
    [ThreadStatic] public static string? LastGiveBack;

    static void Activate(nint top)
    {
        if (Win32.Send(top, WM_NCACTIVATE, 1) is null || Win32.Send(top, WM_ACTIVATE, 1 /* WA_ACTIVE */) is null)
            throw new BackgroundNotApplicableException("The window does not answer activation messages: nothing was typed");
    }

    static void Focus(nint window, Node target, long deadline)
    {
        var focus = Call(new { op = "takeFocus", windowId = (long)window, runtimeId = target.RuntimeId, nativeWindow = (long)target.NativeWindow }, deadline);
        if (focus.Effect != "applied") throw new BackgroundNotApplicableException("Focus without activation not read back on the element: nothing was typed");
    }
}
