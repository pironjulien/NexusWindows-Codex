using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

// Molette Chromium (Chrome, Edge, Electron) par le protocole DevTools, seulement quand la cible a ete lancee avec un port
// de debogage (banc commun du 21/10, recette B de Codex, meme mecanisme que nexus-windows for Claude). Molette « de
// confiance » rendue par la page, sans activation de la fenetre ni curseur. Avant toute entree, quatre preuves
// (relectures de Codex du 21/10) :
// 1. le port figure dans la ligne de commande du processus de la fenetre ;
// 2. l'adresse CONTACTEE (127.0.0.1:port, ou un listener 0.0.0.0:port) est ecoutee par le PID EXACT de la fenetre, et
//    par lui seul (jamais un parent ou un enfant : Electron A lancant B avec le meme port) ; HTTP et WebSocket restent
//    sur cet hote et ce port ;
// 3. une seule page dont le titre decode egale celui de la fenetre (au suffixe de navigateur pres) ;
// 4. preuve ACTIVE de la liaison fenetre <-> page : un titre aleatoire pose sur la page doit apparaitre dans le titre de
//    CETTE fenetre en moins de 0,5 s ; le titre d'origine est toujours remis avant la molette (effet visible : titre de
//    la fenetre change moins d'une demi-seconde). Une page qui ne reflete pas son titre (Electron setTitle) : refus.
// Sinon : non applicable, RIEN n'est envoye. Un seul envoi : reponse absente apres l'envoi = issue inconnue, jamais
// rejouee ni suivie d'une autre technique.
static class Cdp
{
    const int TimeoutMs = 2000, ProofMs = 500;
    [DllImport("kernel32.dll")] static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(nint process, int infoClass, nint buffer, int length, out int returned);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(nint table, ref int size, bool sorted, int family, int tableClass, uint reserved);

    // Ligne de commande d'un processus (ProcessCommandLineInformation, Windows 8.1+), sans WMI ; null si illisible.
    static string? CommandLine(uint pid)
    {
        var process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process == 0) return null;
        var buffer = Marshal.AllocHGlobal(65536);
        try
        {
            if (NtQueryInformationProcess(process, 60, buffer, 65536, out _) < 0) return null;
            var length = (ushort)Marshal.ReadInt16(buffer); // UNICODE_STRING.Length (octets)
            var text = Marshal.ReadIntPtr(buffer, 8);       // UNICODE_STRING.Buffer (dans notre tampon)
            return length == 0 || text == 0 ? null : Marshal.PtrToStringUni(text, length / 2);
        }
        finally { Marshal.FreeHGlobal(buffer); CloseHandle(process); }
    }

    // Listeners TCP IPv4 du port : (adresse locale, PID proprietaire).
    static List<(string Address, uint Pid)> Listeners(int port)
    {
        var found = new List<(string, uint)>();
        var size = 0;
        GetExtendedTcpTable(0, ref size, false, 2 /* AF_INET */, 3 /* TCP_TABLE_OWNER_PID_LISTENER */, 0);
        if (size == 0) return found;
        var table = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(table, ref size, false, 2, 3, 0) != 0) return found;
            var count = Marshal.ReadInt32(table);
            for (var i = 0; i < count; i++)
            {
                var row = table + 4 + i * 24; // MIB_TCPROW_OWNER_PID : etat, adresse, port, adresse distante, port distant, PID
                var raw = (uint)Marshal.ReadInt32(row, 8);
                if ((int)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF)) != port) continue;
                found.Add((new IPAddress((uint)Marshal.ReadInt32(row, 4)).ToString(), (uint)Marshal.ReadInt32(row, 20)));
            }
        }
        finally { Marshal.FreeHGlobal(table); }
        return found;
    }

    // L'adresse contactee (127.0.0.1:port, a defaut un listener 0.0.0.0:port) est-elle ecoutee par CE PID et lui seul ?
    public static bool OwnsPort(uint windowPid, IEnumerable<(string Address, uint Pid)> listeners)
    {
        var reached = listeners.Where(l => l.Address is "127.0.0.1" or "0.0.0.0").ToList();
        return reached.Count > 0 && reached.All(l => l.Pid == windowPid);
    }

    // Port 0 (« choisi par Chromium ») ou absent : pas de port connu.
    public static int? PortFrom(string? commandLine)
    {
        var match = commandLine is null ? null : Regex.Match(commandLine, @"--remote-debugging-port[= ](\d{1,5})(?!\d)");
        return match is { Success: true } && int.TryParse(match.Groups[1].Value, out var port) && port is > 0 and < 65536 ? port : null;
    }

    // Titre de fenetre d'un navigateur : « page - [profil - ]Microsoft Edge|Google Chrome|Chromium » ; Edge a onglets ecrit
    // « page - Profil 1 – Microsoft Edge » (tiret demi-cadratin, mesure le 22/10, preuve C) ; Electron : la page.
    static readonly Regex BrowserSuffix = new("^ [-–] (?:[^\\r\\n]+? [-–] )?(?:Microsoft​? Edge|Google Chrome|Chromium|Brave)$", RegexOptions.CultureInvariant);
    public static bool TitleMatches(string windowTitle, string pageTitle) =>
        pageTitle.Length > 0 && (windowTitle == pageTitle ||
            windowTitle.StartsWith(pageTitle, StringComparison.Ordinal) && BrowserSuffix.IsMatch(windowTitle[pageTitle.Length..]));

    // Page candidate : titre decode (/json/list echappe en HTML : « A &amp; B ») egal a celui de la fenetre au suffixe de
    // navigateur pres, exactement une ; son WebSocket doit rester sur l'hote et le port prouves. Sinon : refus. La liaison
    // reelle est ensuite prouvee activement (Prove).
    public static string PickPage(JsonElement targets, string windowTitle, int port)
    {
        var pages = targets.EnumerateArray()
            .Where(t => t.TryGetProperty("type", out var type) && type.GetString() == "page" && t.TryGetProperty("webSocketDebuggerUrl", out _))
            .ToList();
        var matching = pages.Where(t => TitleMatches(windowTitle, WebUtility.HtmlDecode(t.TryGetProperty("title", out var title) ? title.GetString() ?? "" : ""))).ToList();
        if (matching.Count != 1)
            throw new BackgroundNotApplicableException($"No single DevTools page titled like this window ({pages.Count} pages, {matching.Count} matching): nothing was sent");
        if (!Uri.TryCreate(matching[0].GetProperty("webSocketDebuggerUrl").GetString(), UriKind.Absolute, out var url) || url.Scheme != "ws" ||
            url.Host is not ("127.0.0.1" or "localhost") || url.Port != port)
            throw new BackgroundNotApplicableException("DevTools page socket is not on the proven host and port: nothing was sent");
        return $"ws://127.0.0.1:{port}{url.PathAndQuery}";
    }

    // Controle hors ligne (tests) : stdin = {"title", "targets", "port", "commandLine", "pid", "listeners": [{"address",
    // "pid"}]} ; sortie {"url"} ou {"error"}, "port" (lu dans la ligne de commande) et "owned".
    public static int SelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var root = input.RootElement;
        var port = PortFrom(root.TryGetProperty("commandLine", out var c) ? c.GetString() : null);
        bool? owned = root.TryGetProperty("pid", out var p)
            ? OwnsPort(p.GetUInt32(), root.GetProperty("listeners").EnumerateArray().Select(l => (l.GetProperty("address").GetString()!, l.GetProperty("pid").GetUInt32())))
            : null;
        var pagePort = root.TryGetProperty("port", out var pp) ? pp.GetInt32() : 9222;
        object result;
        try { result = new { url = PickPage(root.GetProperty("targets"), root.GetProperty("title").GetString() ?? "", pagePort), port, owned }; }
        catch (BackgroundNotApplicableException error) { result = new { error = error.Message, port, owned }; }
        Console.WriteLine(JsonSerializer.Serialize(result));
        return 0;
    }

    // Zones de rendu VISIBLES de toute la fenetre (Chrome_RenderWidgetHostHWND), a l'ecran.
    static List<Win32.Rect> Surfaces(nint window)
    {
        var found = new List<Win32.Rect>();
        Win32.EnumChildWindows(window, (child, _) =>
        {
            if (Win32.ClassName(child) == "Chrome_RenderWidgetHostHWND" && Win32.IsWindowVisible(child) && Win32.GetWindowRect(child, out var r) && !r.Empty)
                found.Add(r);
            return true;
        }, 0);
        return found;
    }

    // Regle COMMUNE aux trois NexusWindows (relecture de Codex du 21/10 a 19:18) : exactement UNE zone de rendu visible dans
    // toute la fenetre, le point dedans, et sa taille physique egale a round(innerWidth x DPR) / round(innerHeight x DPR)
    // a ceil(DPR) px pres. Plusieurs zones visibles (applis multi-vues) : hors perimetre, refus. Rend l'ecart mesure.
    public static (int Index, int GapWidth, int GapHeight) PickSurface(IReadOnlyList<Win32.Rect> surfaces, int x, int y, double innerWidth, double innerHeight, double ratio)
    {
        if (!(double.IsFinite(innerWidth) && double.IsFinite(innerHeight) && double.IsFinite(ratio)) || innerWidth <= 0 || innerHeight <= 0 || ratio is <= 0.1 or >= 16)
            throw new BackgroundNotApplicableException("Page size or devicePixelRatio unreadable: nothing was sent");
        if (surfaces.Count != 1)
            throw new BackgroundNotApplicableException($"{surfaces.Count} visible rendered surfaces in the window (multi-view apps are out of scope): nothing was sent");
        var r = surfaces[0];
        if (x < r.Left || y < r.Top || x >= r.Right || y >= r.Bottom)
            throw new BackgroundNotApplicableException("The point is not on the rendered page: nothing was sent");
        var (gapWidth, gapHeight) = (r.Width - (int)Math.Round(innerWidth * ratio), r.Height - (int)Math.Round(innerHeight * ratio));
        var tolerance = (int)Math.Ceiling(ratio);
        if (Math.Abs(gapWidth) > tolerance || Math.Abs(gapHeight) > tolerance)
            throw new BackgroundNotApplicableException($"Rendered surface {r.Width}x{r.Height} is not the proven page ({innerWidth}x{innerHeight} at {ratio}, gap {gapWidth}/{gapHeight} px): nothing was sent");
        return (0, gapWidth, gapHeight);
    }

    // Controle hors ligne (tests) : stdin = {"surfaces": [[gauche, haut, droite, bas]], "point": [x, y], "inner": [l, h],
    // "ratio"} ; sortie {"index", "gap"} ou {"error"}.
    public static int SurfaceSelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var root = input.RootElement;
        var surfaces = root.GetProperty("surfaces").EnumerateArray().Select(a => a.EnumerateArray().Select(v => v.GetInt32()).ToArray())
            .Select(a => new Win32.Rect { Left = a[0], Top = a[1], Right = a[2], Bottom = a[3] }).ToList();
        var point = root.GetProperty("point").EnumerateArray().Select(v => v.GetInt32()).ToArray();
        var inner = root.GetProperty("inner").EnumerateArray().Select(v => v.GetDouble()).ToArray();
        object result;
        try
        {
            var (index, gw, gh) = PickSurface(surfaces, point[0], point[1], inner[0], inner[1], root.GetProperty("ratio").GetDouble());
            result = new { index, gap = new[] { gw, gh } };
        }
        catch (BackgroundNotApplicableException error) { result = new { error = error.Message }; }
        Console.WriteLine(JsonSerializer.Serialize(result));
        return 0;
    }

    // Une connexion DevTools a une page (une requete a la fois, reponses correlees par id, evenements ignores).
    sealed class Session : IDisposable
    {
        readonly ClientWebSocket socket = new();
        int id;
        public Session(string url)
        {
            using var cancel = new CancellationTokenSource(TimeoutMs);
            socket.ConnectAsync(new Uri(url), cancel.Token).GetAwaiter().GetResult();
        }
        public JsonElement Call(string method, object parameters)
        {
            var mine = ++id;
            var payload = JsonSerializer.SerializeToUtf8Bytes(new { id = mine, method, @params = parameters });
            using var cancel = new CancellationTokenSource(TimeoutMs);
            socket.SendAsync(payload, WebSocketMessageType.Text, true, cancel.Token).GetAwaiter().GetResult();
            var buffer = new byte[1 << 16];
            while (true)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult part;
                do
                {
                    part = socket.ReceiveAsync(buffer, cancel.Token).GetAwaiter().GetResult();
                    message.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                using var reply = JsonDocument.Parse(message.ToArray());
                if (!reply.RootElement.TryGetProperty("id", out var got) || got.GetInt32() != mine) continue; // evenements
                if (reply.RootElement.TryGetProperty("error", out var error)) throw new InvalidOperationException($"DevTools {method}: {error}");
                return reply.RootElement.GetProperty("result").Clone();
            }
        }
        // Exception JavaScript (exceptionDetails) : jamais un resultat (relecture de Codex du 22/10 11:27).
        public JsonElement Evaluate(string expression)
        {
            var reply = Call("Runtime.evaluate", new { expression, returnByValue = true });
            if (reply.TryGetProperty("exceptionDetails", out var details)) throw new InvalidOperationException($"DevTools evaluation raised: {details}");
            return reply.GetProperty("result");
        }
        public void Dispose() => socket.Dispose();
    }

    public static Outcome Wheel(nint window, int x, int y, int deltaY, int deltaX, Action started)
    {
        var pid = Win32.ProcessOf(window);
        var port = PortFrom(CommandLine(pid)) ?? throw new BackgroundNotApplicableException(
            "Chromium ignores a posted wheel (measured) and the target has no DevTools port: nothing was sent");
        if (!OwnsPort(pid, Listeners(port)))
            throw new BackgroundNotApplicableException($"127.0.0.1:{port} is not listened to by the window's own process alone: nothing was sent");
        var surfaces = Surfaces(window);
        if (surfaces.Count != 1)
            throw new BackgroundNotApplicableException($"{surfaces.Count} visible rendered surfaces in the window (multi-view apps are out of scope): nothing was sent");
        var (cdpX, cdpY) = ScrollPlan.DevTools(deltaY, deltaX);
        string url;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(TimeoutMs) };
            using var targets = JsonDocument.Parse(http.GetStringAsync($"http://127.0.0.1:{port}/json/list").GetAwaiter().GetResult());
            url = PickPage(targets.RootElement, Win32.Title(window), port);
        }
        catch (Exception error) when (error is not BackgroundNotApplicableException)
        {
            throw new BackgroundNotApplicableException($"DevTools port {port} unavailable ({error.GetType().Name}): nothing was sent");
        }
        Session session;
        try { session = new Session(url); }
        catch (Exception error) { throw new BackgroundNotApplicableException($"DevTools page unreachable before input ({error.GetType().Name}): nothing was sent"); }
        using (session)
        {
            Win32.Rect surface;
            double ratio;
            string measured;
            try
            {
                Prove(session.Evaluate, FreshEvaluator(url), () => Win32.Title(window));
                var metrics = session.Evaluate("JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio])");
                var values = metrics.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String
                    ? JsonSerializer.Deserialize<double[]>(v.GetString()!) : null;
                if (values is not { Length: 3 }) throw new BackgroundNotApplicableException("Page size or devicePixelRatio unreadable: nothing was sent");
                var (index, gapWidth, gapHeight) = PickSurface(surfaces, x, y, values[0], values[1], values[2]);
                surface = surfaces[index];
                ratio = values[2];
                // Releve pour le banc : taille CSS, DPR, rectangle de la zone et ecart mesure.
                measured = $"inner {values[0]}x{values[1]} at DPR {values[2]}, surface [{surface.Left},{surface.Top},{surface.Right},{surface.Bottom}], gap {gapWidth}/{gapHeight} px";
            }
            catch (Exception error) when (BeforeInput(error) is var mapped && mapped != error) { throw mapped; }
            var wheel = new { type = "mouseWheel", x = (x - surface.Left) / ratio, y = (y - surface.Top) / ratio, deltaX = cdpX, deltaY = cdpY };
            Dispatch(session.Call, wheel, started);
            return new("background:devtools", $"Input.dispatchMouseEvent mouseWheel (port {port}; {measured})", "sent");
        }
    }

    // Envoi UNIQUE de la molette : arret d'urgence verifie au dernier moment (un arret survenu pendant la preparation, preuve
    // ou mesures, n'envoie rien) ; reponse absente apres l'envoi = issue inconnue, jamais rejouee ni suivie d'une autre
    // technique (traces D de la relecture de Codex du 22/10, --wheel-trace-selftest).
    static void Dispatch(Func<string, object, JsonElement> call, object wheel, Action started)
    {
        EmergencyStop.ThrowIfStopped();
        started();
        try { call("Input.dispatchMouseEvent", wheel); }
        catch (Exception error) { throw new InvalidOperationException("DevTools wheel sent without acknowledgement; outcome unknown, do not replay", error); }
    }

    // Une operation sur une NOUVELLE connexion a la page : ouvre, evalue PUIS ferme, dans le meme appel (relecture de Codex
    // de 19:28 : la session etait fermee avant son usage, le nettoyage de secours echouait toujours).
    public static Func<string, JsonElement> FreshEvaluator(string url) => expression =>
    {
        using var session = new Session(url);
        return session.Evaluate(expression);
    };

    // Preuve active de la liaison fenetre <-> page : un titre aleatoire pose sur la page doit apparaitre dans le titre de
    // CETTE fenetre (au suffixe de navigateur pres) en moins de ProofMs. Pose CONDITIONNELLE (le titre n'a pas change
    // depuis sa lecture) faite SOUS le nettoyage : pose appliquee mais reponse perdue = nettoyage quand meme. Nettoyage
    // conditionnel (le nonce y est encore : un titre legitimement change n'est jamais ecrase), retente sur une NOUVELLE
    // connexion si la premiere casse. Puis le titre FINAL reel de la page (document.title) doit etre celui de la fenetre :
    // un autre onglet active pendant le nettoyage ne passe plus (relecture de Codex de 19:28). Tout echec : refus, rien
    // n'est envoye ; un nettoyage impossible est dit explicitement.
    public static void Prove(Func<string, JsonElement> evaluate, Func<string, JsonElement> fresh, Func<string> windowTitle, string? nonce = null)
    {
        nonce ??= "nexus-" + Guid.NewGuid().ToString("N");
        var title = Text(evaluate("document.title")) ?? throw new BackgroundNotApplicableException("Page title unreadable: nothing was sent");
        var (quotedTitle, quotedNonce) = (JsonSerializer.Serialize(title), JsonSerializer.Serialize(nonce));
        var restore = $"(() => {{ if (document.title === {quotedNonce}) document.title = {quotedTitle}; return true; }})()";
        var seen = false;
        string? dressing = null; // habillage EXACT de la fenetre autour du titre de la page, observe avec le nonce
        var touched = false;     // pose envoyee : appliquee, ou reponse perdue (issue inconnue)
        Exception? failure = null;
        try
        {
            touched = true;
            var posed = evaluate($"(() => {{ if (document.title !== {quotedTitle}) return false; document.title = {quotedNonce}; return true; }})()");
            if (!(posed.TryGetProperty("value", out var p) && p.ValueKind == JsonValueKind.True))
            {
                touched = false;
                throw new BackgroundNotApplicableException("Page title changed while being read: nothing was sent");
            }
            var clock = Stopwatch.StartNew();
            while (!seen && clock.ElapsedMilliseconds < ProofMs)
            {
                var shown = windowTitle();
                seen = TitleMatches(shown, nonce);
                if (seen) dressing = shown[nonce.Length..];
                else Thread.Sleep(20);
            }
        }
        catch (Exception error) { failure = error; }
        // Remise VERIFIEE sur tous les chemins, avant de propager toute erreur (relecture de Codex du 22/10 11:27) : page puis
        // titre de la fenetre ; nonce restant ou remise invérifiable = refus terminal.
        if (touched) VerifyCleanup(evaluate, fresh, windowTitle, restore, nonce);
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
        if (!seen) throw new BackgroundNotApplicableException("This DevTools page is not proven to be the window (its title never showed up in the window): nothing was sent");
        string? final;
        try { final = Text(evaluate("document.title")); }
        catch (Exception) { final = Text(fresh("document.title")); }
        if (final is null || final.Contains(nonce, StringComparison.Ordinal))
            throw new ActionRefusedException($"Test title « {nonce} » may remain on the page (unreadable after the proof): no wheel was sent and no other technique may follow");
        // Titre final + l'habillage EXACT vu avec le nonce (relecture de Codex de 19:36) : le suffixe de navigateur n'est plus
        // reinterprete (onglet B « Rapport - Personnel » devant ne passe plus pour la page A « Rapport »).
        var back = Stopwatch.StartNew();
        while (windowTitle() != final + dressing)
        {
            if (back.ElapsedMilliseconds >= ProofMs)
                throw new BackgroundNotApplicableException("The window no longer shows the proven page after cleanup (binding changed): nothing was sent");
            Thread.Sleep(20);
        }
    }

    // Remise du titre apres une pose : nettoyage conditionnel (deux connexions), puis titre de la PAGE relu sans le nonce,
    // puis titre de la FENETRE sans le nonce en moins de ProofMs. Tout echec : refus terminal, la page est peut-etre
    // modifiee ; aucune autre technique ne suit, premier plan permis ou non (preuve C).
    static void VerifyCleanup(Func<string, JsonElement> evaluate, Func<string, JsonElement> fresh, Func<string> windowTitle, string restore, string nonce)
    {
        ActionRefusedException Terminal(string why) =>
            new($"Test title « {nonce} » may remain ({why}): no wheel was sent and no other technique may follow");
        if (!Clean(evaluate, fresh, restore)) throw Terminal("cleanup failed on two connections");
        string? page;
        try { page = Text(evaluate("document.title")); }
        catch (Exception)
        {
            try { page = Text(fresh("document.title")); }
            catch (Exception) { page = null; }
        }
        if (page is null) throw Terminal("page title unreadable after cleanup");
        if (page.Contains(nonce, StringComparison.Ordinal)) throw Terminal("still on the page after cleanup");
        var clock = Stopwatch.StartNew();
        while (windowTitle().Contains(nonce, StringComparison.Ordinal))
        {
            if (clock.ElapsedMilliseconds >= ProofMs) throw Terminal("still shown in the window title");
            Thread.Sleep(20);
        }
    }

    // Classement d'une erreur de preparation (preuve, mesures) : refus, arret et non applicable gardes ; toute autre
    // erreur, avant l'entree, devient « non applicable » (rien n'a ete envoye).
    static Exception BeforeInput(Exception error) =>
        error is BackgroundNotApplicableException or ActionRefusedException or EmergencyStopException ? error
            : new BackgroundNotApplicableException($"DevTools page unreachable before input ({error.GetType().Name}): nothing was sent");

    static string? Text(JsonElement result) => result.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // Nettoyage conditionnel, sur la connexion courante puis, si elle a casse, sur une nouvelle connexion a la meme page.
    // Reussi seulement si le script a rendu `true` (un objet d'erreur ou autre valeur ne vaut pas nettoyage).
    static bool Clean(Func<string, JsonElement> evaluate, Func<string, JsonElement> fresh, string restore)
    {
        static bool Done(JsonElement result) => result.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.True;
        try { if (Done(evaluate(restore))) return true; }
        catch (Exception) { }
        try { return Done(fresh(restore)); }
        catch (Exception) { return false; }
    }

    // Controle hors ligne (tests) de la preuve par le titre sur une page et une fenetre simulees, DECOUPLEES (le titre de la
    // fenetre n'est pas deduit de la page). stdin = {"scenario"} : « nominal », « lost-pose » (pose appliquee, reponse
    // perdue, connexion cassee), « title-changed », « dead » (deux connexions cassees apres la pose), « never-shown »,
    // « tab-switched » (un autre onglet est affiche pendant le nettoyage), « page-retitled » (la page change elle-meme
    // de titre pendant la preuve), « profile-confusion » (l'onglet B « Labo - Personnel » passe devant). Sortie : {"ok"}
    // ou {"error"}, et "pageTitle" final.
    public static int ProveSelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var scenario = input.RootElement.GetProperty("scenario").GetString();
        var page = "Labo";
        var shown = "Labo";
        var (broken, posedOnce) = (false, false);
        var stuck = scenario is "hwnd-stuck" or "lost-pose-hwnd-stuck";
        JsonElement Value(object value) => JsonSerializer.SerializeToElement(new { value });
        JsonElement Run(string expression, bool primary)
        {
            if (primary && broken || !primary && scenario == "dead") throw new InvalidOperationException("connection lost");
            if (scenario == "restore-error-object" && expression.StartsWith("(() => { if (document.title === ", StringComparison.Ordinal))
                return JsonSerializer.SerializeToElement(new { type = "object", subtype = "error", description = "TypeError" });
            if (expression == "document.title") return Value(page);
            var m = Regex.Match(expression, "^\\(\\(\\) => \\{ if \\(document.title (!==|===) (\"[^\"]*\")\\) (?:return false; )?document.title = (\"[^\"]*\");");
            if (!m.Success) throw new InvalidOperationException("unexpected expression");
            var (op, compared, assigned) = (m.Groups[1].Value, JsonSerializer.Deserialize<string>(m.Groups[2].Value)!, JsonSerializer.Deserialize<string>(m.Groups[3].Value)!);
            if (op == "!==")
            {
                if (scenario == "title-changed") shown = page = "Autre";
                if (page != compared) return Value(false);
                shown = page = assigned;
                posedOnce = true;
                if (scenario is "lost-pose" or "dead" or "lost-pose-hwnd-stuck") { broken = true; throw new InvalidOperationException("reply lost"); }
                return Value(true);
            }
            if (page == compared) page = assigned;
            shown = scenario == "tab-switched" ? "Onglet B" : scenario == "profile-confusion" ? page + " - Personnel" : page;
            return Value(true);
        }
        var dressing = scenario == "profile-confusion" ? " - Google Chrome" : " - Microsoft Edge";
        string Window()
        {
            if (stuck && posedOnce) return "nexus-test" + dressing; // titre de la fenetre reste sur le nonce
            if (scenario == "page-retitled" && shown.StartsWith("nexus-", StringComparison.Ordinal)) { var nonce = shown; page = "Nouveau"; shown = "Nouveau"; return nonce + dressing; }
            return (scenario == "never-shown" && shown.StartsWith("nexus-", StringComparison.Ordinal) ? "Labo" : shown) + dressing;
        }
        object result;
        try { Prove(e => Run(e, true), e => Run(e, false), Window, "nexus-test"); result = new { ok = true, pageTitle = page }; }
        catch (Exception error) { result = new { error = error.Message, kind = error.GetType().Name, wheelKind = BeforeInput(error).GetType().Name, pageTitle = page }; }
        Console.WriteLine(JsonSerializer.Serialize(result));
        return 0;
    }

    // Preuve C (relecture de Codex du 22/10) sur un VRAI navigateur (fenetre lancee avec un port DevTools) : la preuve par
    // le titre et son nettoyage passent par les vraies connexions, ruptures provoquees aux points critiques. stdin =
    // {"hwnd", "scenario"} : « nominal » ; « lost-pose » (pose APPLIQUEE puis connexion coupee sans reponse) ; « dead »
    // (en plus, toute nouvelle connexion refusee) ; « legit-retitle » (la page change elle-meme de titre pendant la
    // preuve) ; « tab-switch » (un autre onglet passe devant juste avant le nettoyage). Sortie : issue (ok ou erreur et son
    // type), connexions neuves ouvertes, titre DOM et titre de la FENETRE avant et apres ; « dead » : titre d'origine remis
    // ensuite par le controle lui-meme (indique). Jamais de molette envoyee.
    public static int ProveLiveSelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var window = (nint)input.RootElement.GetProperty("hwnd").GetInt64();
        var scenario = input.RootElement.GetProperty("scenario").GetString();
        var pid = Win32.ProcessOf(window);
        var port = PortFrom(CommandLine(pid)) ?? throw new InvalidOperationException("No DevTools port on this window");
        if (!OwnsPort(pid, Listeners(port))) throw new InvalidOperationException("Port not owned by the window process");
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(TimeoutMs) };
        string url;
        using (var targets = JsonDocument.Parse(http.GetStringAsync($"http://127.0.0.1:{port}/json/list").GetAwaiter().GetResult()))
            url = PickPage(targets.RootElement, Win32.Title(window), port);
        var real = FreshEvaluator(url);
        var original = Text(real("document.title"));
        var windowBefore = Win32.Title(window);
        var primary = new Session(url);
        var (dropped, freshOpened, retitled) = (false, 0, false);
        string? otherTab = null;
        JsonElement Evaluate(string expression)
        {
            if (dropped) throw new InvalidOperationException("primary connection lost");
            if (scenario == "tab-switch" && otherTab is null && expression.StartsWith("(() => { if (document.title === ", StringComparison.Ordinal))
            {
                using var opened = JsonDocument.Parse(http.PutAsync($"http://127.0.0.1:{port}/json/new?about:blank", null).GetAwaiter().GetResult()
                    .Content.ReadAsStringAsync().GetAwaiter().GetResult());
                otherTab = opened.RootElement.GetProperty("id").GetString();
                Thread.Sleep(400);
            }
            var result = primary.Evaluate(expression);
            if (scenario is "lost-pose" or "dead" && expression.Contains("return false; document.title = ", StringComparison.Ordinal))
            {
                dropped = true;
                primary.Dispose();
                throw new InvalidOperationException("reply lost after the pose");
            }
            return result;
        }
        JsonElement Fresh(string expression)
        {
            if (scenario == "dead") throw new InvalidOperationException("new connection refused");
            freshOpened++;
            return real(expression);
        }
        string Shown()
        {
            var shown = Win32.Title(window);
            if (scenario == "legit-retitle" && !retitled && shown.StartsWith("nexus-", StringComparison.Ordinal))
            {
                retitled = true;
                real("document.title = 'Titre legitime'");
            }
            return shown;
        }
        string outcome, kind = "";
        try { Prove(Evaluate, Fresh, Shown); outcome = "ok"; }
        catch (Exception error) { outcome = error.Message; kind = error.GetType().Name; }
        finally { if (!dropped) primary.Dispose(); }
        var domAfter = Text(real("document.title"));
        Thread.Sleep(300);
        var windowAfter = Win32.Title(window);
        string? restoredByTest = null;
        if (otherTab is not null) http.GetAsync($"http://127.0.0.1:{port}/json/close/{otherTab}").GetAwaiter().GetResult();
        if (domAfter is not null && domAfter.StartsWith("nexus-", StringComparison.Ordinal))
        {
            real($"document.title = {JsonSerializer.Serialize(original)}");
            restoredByTest = original;
        }
        Console.WriteLine(JsonSerializer.Serialize(new { scenario, outcome, kind, freshOpened, original, windowBefore, domAfter, windowAfter, restoredByTest, tabOpened = otherTab is not null }));
        return 0;
    }

    // Traces D (relecture de Codex du 22/10), par la VRAIE connexion (Session) contre un serveur DevTools local instrumente :
    // « ack-lost » : la molette est recue puis la connexion coupee sans reponse ; « stop-during-prepare » : l'arret
    // d'urgence est pose pendant la preparation (evaluation). Sortie : {"outcome", "started", "dispatched", "evaluated"}.
    // Exige NEXUS_SHARED_HOME (dossier de test) : le vrai fichier d'arret n'est jamais ecrit.
    public static int WheelTraceSelfTest()
    {
        using var input = JsonDocument.Parse(Console.In.ReadToEnd());
        var scenario = input.RootElement.GetProperty("scenario").GetString();
        if (!EmergencyStop.TestDirectory) { Console.WriteLine(JsonSerializer.Serialize(new { error = "NEXUS_SHARED_HOME required" })); return 1; }
        var (port, dispatched, evaluated, server) = InstrumentedServer();
        var started = 0;
        string outcome;
        try
        {
            using var session = new Session($"ws://127.0.0.1:{port}/devtools/page/test");
            session.Evaluate("document.title"); // preparation (preuve, mesures)
            if (scenario == "stop-during-prepare") File.WriteAllText(Path.Combine(EmergencyStop.Directory, "stop"), "selftest");
            Dispatch(session.Call, new { type = "mouseWheel", x = 10, y = 10, deltaX = 0, deltaY = 120 }, () => started++);
            outcome = "acknowledged";
        }
        catch (EmergencyStopException) { outcome = "stopped"; }
        catch (InvalidOperationException error) when (error.Message.Contains("outcome unknown")) { outcome = "unknown"; }
        server.Join(2000);
        Console.WriteLine(JsonSerializer.Serialize(new { outcome, started, dispatched = dispatched.Count, evaluated = evaluated.Count }));
        return 0;
    }

    // Serveur DevTools local : repond a Runtime.evaluate ; a Input.dispatchMouseEvent, compte puis coupe sans reponse.
    static (int Port, List<string> Dispatched, List<string> Evaluated, Thread Server) InstrumentedServer()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var (dispatched, evaluated) = (new List<string>(), new List<string>());
        var server = new Thread(() =>
        {
            try
            {
                using var client = listener.AcceptTcpClient();
                using var stream = client.GetStream();
                Handshake(stream);
                while (ReadFrame(stream) is { } data)
                {
                    using var message = JsonDocument.Parse(data);
                    var method = message.RootElement.GetProperty("method").GetString()!;
                    if (method == "Input.dispatchMouseEvent") { dispatched.Add(method); client.Client.Close(); break; }
                    evaluated.Add(message.RootElement.GetProperty("params").GetProperty("expression").GetString()!);
                    WriteFrame(stream, JsonSerializer.SerializeToUtf8Bytes(new { id = message.RootElement.GetProperty("id").GetInt32(), result = new { result = new { type = "string", value = "Labo" } } }));
                }
            }
            catch (Exception) { }
            finally { listener.Stop(); }
        }) { IsBackground = true };
        server.Start();
        return (port, dispatched, evaluated, server);
    }

    static void Handshake(System.Net.Sockets.NetworkStream stream)
    {
        var request = new List<byte>();
        while (request.Count < 4 || request[^4] != '\r' || request[^3] != '\n' || request[^2] != '\r' || request[^1] != '\n') request.Add((byte)stream.ReadByte());
        var key = Regex.Match(System.Text.Encoding.ASCII.GetString(request.ToArray()), @"Sec-WebSocket-Key: (\S+)", RegexOptions.IgnoreCase).Groups[1].Value;
        var accept = Convert.ToBase64String(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        stream.Write(System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"));
    }

    static byte[]? ReadFrame(System.Net.Sockets.NetworkStream stream)
    {
        var b0 = stream.ReadByte(); var b1 = stream.ReadByte();
        if (b0 < 0 || (b0 & 0x0F) == 8) return null;
        long length = b1 & 0x7F;
        if (length == 126) length = (stream.ReadByte() << 8) | stream.ReadByte();
        var mask = new byte[4]; stream.ReadExactly(mask);
        var data = new byte[length]; stream.ReadExactly(data);
        for (var i = 0; i < data.Length; i++) data[i] ^= mask[i % 4];
        return data;
    }

    static void WriteFrame(System.Net.Sockets.NetworkStream stream, byte[] reply)
    {
        var frame = new List<byte> { 0x81 };
        if (reply.Length < 126) frame.Add((byte)reply.Length); else { frame.Add(126); frame.Add((byte)(reply.Length >> 8)); frame.Add((byte)reply.Length); }
        frame.AddRange(reply);
        stream.Write(frame.ToArray());
    }

    // Controle hors ligne (tests) du nettoyage de secours par la VRAIE fabrique de connexion (FreshEvaluator, Session) contre
    // un serveur WebSocket local minimal qui repond a Runtime.evaluate. Sortie : {"cleaned", "received"}.
    public static int SessionSelfTest()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var received = new List<string>();
        var server = new Thread(() =>
        {
            try
            {
                using var client = listener.AcceptTcpClient();
                using var stream = client.GetStream();
                var request = new List<byte>();
                while (request.Count < 4 || request[^4] != '\r' || request[^3] != '\n' || request[^2] != '\r' || request[^1] != '\n') request.Add((byte)stream.ReadByte());
                var key = Regex.Match(System.Text.Encoding.ASCII.GetString(request.ToArray()), @"Sec-WebSocket-Key: (\S+)", RegexOptions.IgnoreCase).Groups[1].Value;
                var accept = Convert.ToBase64String(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                var head = System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
                stream.Write(head);
                while (true)
                {
                    var b0 = stream.ReadByte(); var b1 = stream.ReadByte();
                    if (b0 < 0 || (b0 & 0x0F) == 8) break;
                    long length = b1 & 0x7F;
                    if (length == 126) length = (stream.ReadByte() << 8) | stream.ReadByte();
                    var mask = new byte[4]; stream.ReadExactly(mask);
                    var data = new byte[length]; stream.ReadExactly(data);
                    for (var i = 0; i < data.Length; i++) data[i] ^= mask[i % 4];
                    using var message = JsonDocument.Parse(data);
                    received.Add(message.RootElement.GetProperty("params").GetProperty("expression").GetString()!);
                    var reply = JsonSerializer.SerializeToUtf8Bytes(new { id = message.RootElement.GetProperty("id").GetInt32(), result = new { result = new { type = "boolean", value = true } } });
                    var frame = new List<byte> { 0x81 };
                    if (reply.Length < 126) frame.Add((byte)reply.Length); else { frame.Add(126); frame.Add((byte)(reply.Length >> 8)); frame.Add((byte)reply.Length); }
                    frame.AddRange(reply);
                    stream.Write(frame.ToArray());
                }
            }
            catch (Exception) { }
        }) { IsBackground = true };
        server.Start();
        var restore = "(() => { if (document.title === \"nexus-test\") document.title = \"Labo\"; return true; })()";
        var cleaned = Clean(_ => throw new InvalidOperationException("primary connection lost"), FreshEvaluator($"ws://127.0.0.1:{port}/devtools/page/test"), restore);
        server.Join(2000);
        listener.Stop();
        Console.WriteLine(JsonSerializer.Serialize(new { cleaned, received }));
        return 0;
    }
}
