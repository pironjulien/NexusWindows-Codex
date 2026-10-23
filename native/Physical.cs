using System.Runtime.InteropServices;
using System.Text.Json;

// Vraie souris et vrai clavier PROPRES au helper (SendInput), sans Sky (decision de Julien du 22/10 : un Nexus Windows
// complet et autonome, Sky en secours seulement). Meme recette que nexus-windows for Claude (realinput.py), eprouvee au
// banc commun : seulement quand l'arriere-plan est impossible et l'entree physique permise, l'APPELANT tenant le jeton
// commun de premier plan (withForeground) qui rendra la fenetre de Julien a la fin.
// 1. la cible passe devant (restauree si reduite) ; Windows refuse : rien n'est envoye ;
// 2. avant chaque lot : arret d'urgence, cible toujours devant, point sur une fenetre du processus cible ;
// 3. deplacement et boutons d'un clic dans UN SEUL SendInput, coordonnees absolues jointes a chaque evenement (rien ne
//    s'intercale, le clic ne tombe jamais sous le curseur de Julien) ;
// 4. curseur remis a sa place si nous l'avons deplace et qu'il n'a pas bouge depuis.
// Pixels reels de chaque ecran (app.manifest PerMonitorV2), comme la capture native.
static class Physical
{
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008,
        MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800,
        MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const uint GA_ROOT = 2;

    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int Dx, Dy; public uint Data, Flags, Time; public nint Extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort Vk, Scan; public uint Flags, Time; public nint Extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] static extern nint WindowFromPoint(Win32.Point point);
    [DllImport("user32.dll")] static extern nint GetKeyboardLayout(uint thread);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint hwnd, int attribute, out Win32.Rect rect, int size);

    static readonly Dictionary<string, (uint Down, uint Up)> Buttons = new()
    {
        ["left"] = (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        ["right"] = (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        ["middle"] = (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };

    // Fenetre de la cible : la fenetre liee elle-meme ou une fenetre qu'elle POSSEDE (chaine des proprietaires : boite,
    // menu possede). Jamais une soeur du meme processus (relecture de Codex du 22/10 12:22 : deux fenetres Edge), ni une
    // surgissante seulement classee comme telle (12:57 : une palette non activante etrangere couvrant le point passait).
    static bool OfTarget(nint hwnd, nint target)
    {
        if (hwnd == 0) return false;
        var root = Win32.GetAncestor(hwnd, GA_ROOT);
        if (root == 0) root = hwnd;
        if (root == target) return true;
        for (var (owner, depth) = (Win32.GetWindow(root, Win32.GW_OWNER), 0); owner != 0 && depth < 16; owner = Win32.GetWindow(owner, Win32.GW_OWNER), depth++)
            if (owner == target) return true;
        return false;
    }

    // La cible devant, ou refus (rien n'est envoye). Restauree si reduite ; fil du premier plan attache le temps de
    // SetForegroundWindow, comme la restitution du premier plan (ForegroundReturn).
    // Mise au premier plan seule (bail d'interaction de la session, sous son jeton) : sans Sky.
    public static object Activate(nint window, Action started)
    {
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        started();
        BringToFront(window);
        return new { ok = true, technique = "physical:native", mechanism = "SetForegroundWindow", effect = "applied", foregroundTaken = true };
    }

    static void BringToFront(nint window)
    {
        if (OfTarget(Win32.GetForegroundWindow(), window)) return;
        if (Win32.IsIconic(window)) { EmergencyStop.ThrowIfStopped(); ShowWindow(window, 9 /* SW_RESTORE */); Thread.Sleep(150); }
        for (var attempt = 0; attempt < 2; attempt++)
        {
            EmergencyStop.ThrowIfStopped();
            var fg = Win32.GetForegroundWindow();
            var own = Win32.GetCurrentThreadId();
            var thread = fg == 0 ? 0 : Win32.GetWindowThreadProcessId(fg, out _);
            var attached = thread != 0 && thread != own && Win32.AttachThreadInput(own, thread, true);
            try { Win32.BringWindowToTop(window); Win32.SetForegroundWindow(window); }
            finally { if (attached) Win32.AttachThreadInput(own, thread, false); }
            for (var waited = 0; waited < 500; waited += 25)
            {
                if (OfTarget(Win32.GetForegroundWindow(), window)) return;
                Thread.Sleep(25);
            }
        }
        var holder = Win32.GetForegroundWindow();
        throw new ActionRefusedException($"Windows refuses to bring the window to the front (foreground held by {(holder == 0 ? "no window" : Win32.ClassName(holder))}): nothing was sent");
    }

    // Avant chaque lot : arret d'urgence, cible devant, point sur la cible (fenetre intercalee : arret, rien d'autre).
    static void Guard(nint window, int? x = null, int? y = null)
    {
        EmergencyStop.ThrowIfStopped();
        if (!OfTarget(Win32.GetForegroundWindow(), window))
            throw new InvalidOperationException("The target is no longer in the foreground (Julien took over?): stopped, nothing else sent");
        if (x is { } px && y is { } py && !OfTarget(WindowFromPoint(new Win32.Point { X = px, Y = py }), window))
            throw new InvalidOperationException($"The point ({px}, {py}) does not hit the target window (covered?): stopped, nothing else sent");
    }

    static Input Mouse(uint flags, int dx = 0, int dy = 0, int data = 0) =>
        new() { Type = INPUT_MOUSE, U = new InputUnion { Mouse = new MouseInput { Dx = dx, Dy = dy, Data = unchecked((uint)data), Flags = flags } } };

    // Evenement souris AU point : deplacement absolu sur le bureau virtuel joint au bouton ou a la molette.
    static Input At(uint flags, int x, int y, int data = 0)
    {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        var ax = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1));
        var ay = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1));
        return Mouse(flags | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, data);
    }

    static Input Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) => new()
    {
        Type = INPUT_KEYBOARD,
        U = new InputUnion { Keyboard = new KeyboardInput { Vk = unicode ? (ushort)0 : vk, Scan = scan,
            Flags = (up ? KEYEVENTF_KEYUP : 0) | (unicode ? KEYEVENTF_UNICODE : 0) | (!unicode && Keys.IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0) } },
    };

    static void Send(Action started, params Input[] inputs)
    {
        started();
        var inserted = (int)SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
        if (inserted == inputs.Length) return;
        // Lot insere en partie (relecture de Codex du 22/10 12:22) : boutons et touches appuyes dans la partie inseree
        // et non relaches sont relaches au mieux, puis issue inconnue, jamais rejouee.
        Release(inputs[..Math.Max(0, inserted)]);
        throw new InvalidOperationException($"Windows inserted {inserted} of {inputs.Length} simulated input events (locked screen, UAC or secure desktop); outcome unknown, do not replay");
    }

    static void Release(Input[] sent)
    {
        var ups = new List<Input>();
        var mouseUps = new Dictionary<uint, uint> { [MOUSEEVENTF_LEFTDOWN] = MOUSEEVENTF_LEFTUP, [MOUSEEVENTF_RIGHTDOWN] = MOUSEEVENTF_RIGHTUP, [MOUSEEVENTF_MIDDLEDOWN] = MOUSEEVENTF_MIDDLEUP };
        foreach (var (down, up) in mouseUps)
        {
            var downs = sent.Count(i => i.Type == INPUT_MOUSE && (i.U.Mouse.Flags & down) != 0);
            var released = sent.Count(i => i.Type == INPUT_MOUSE && (i.U.Mouse.Flags & up) != 0);
            if (downs > released) ups.Add(Mouse(up));
        }
        foreach (var key in sent.Where(i => i.Type == INPUT_KEYBOARD && (i.U.Keyboard.Flags & KEYEVENTF_KEYUP) == 0).Reverse())
        {
            var k = key.U.Keyboard;
            var released = sent.Any(i => i.Type == INPUT_KEYBOARD && (i.U.Keyboard.Flags & KEYEVENTF_KEYUP) != 0 && i.U.Keyboard.Vk == k.Vk && i.U.Keyboard.Scan == k.Scan);
            if (!released) ups.Add(new Input { Type = INPUT_KEYBOARD, U = new InputUnion { Keyboard = k with { Flags = k.Flags | KEYEVENTF_KEYUP } } });
        }
        if (ups.Count > 0) SendInput((uint)ups.Count, [.. ups], Marshal.SizeOf<Input>());
    }

    // `relocate` : cible d'une observation native, relue SOUS le jeton apres la mise au premier plan et juste avant
    // l'entree (identite, ascendance, rectangle) ; rend le centre de sa partie visible (relecture de Codex du 22/10 12:22).
    public static object Act(nint window, JsonElement request, Action started, Func<(int X, int Y)>? relocate = null)
    {
        int Int(string key) => request.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        string Str(string key, string fallback) => request.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
        var action = Str("action", "");
        if (action is not ("click" or "wheel" or "drag" or "type" or "key")) throw new InvalidOperationException("Unknown physical action");
        if (!Win32.IsWindowEnabled(window)) throw new ActionRefusedException("Window is disabled (a modal dialog may be open)");
        var (x, y) = (Int("x"), Int("y"));
        // Controles avant toute entree : bouton connu, touche analysable, texte non vide.
        var button = Str("button", "left");
        if (action == "click" && !Buttons.ContainsKey(button)) throw new InvalidOperationException("Invalid mouse button");
        (List<int> Mods, int Vk) combo = default;
        if (action == "key") combo = Keys.ParseFor(Str("key", ""), GetKeyboardLayout(Win32.GetWindowThreadProcessId(window, out _)));
        var text = Str("text", "");
        if (action == "type" && text.Length == 0) throw new InvalidOperationException("Empty text");
        // Point d'une capture native : le cadre DWM releve a la capture est relu ; fenetre deplacee = refus (comme Pointer).
        if (request.TryGetProperty("frame", out var f) && f.ValueKind == JsonValueKind.Array)
        {
            var frame = f.EnumerateArray().Select(e => e.GetInt32()).ToArray();
            if (frame.Length != 4 || DwmGetWindowAttribute(window, 9, out var now, 16) != 0 ||
                now.Left != frame[0] || now.Top != frame[1] || now.Width != frame[2] || now.Height != frame[3])
                throw new ActionRefusedException("Window moved or resized since the native capture: observe again");
        }
        Win32.GetCursorPos(out var cursor);
        var moved = false;
        if (relocate is not null && action != "click") throw new ActionRefusedException("Only a click is aimed at a native target: observe a native screenshot");
        // Clic droit : menus ouverts AVANT, pour rapporter celui que CE clic ouvre (comme le clic droit poste).
        var rightClick = action == "click" && button == "right";
        var menusBefore = rightClick ? Win32.LinkedMenuPopups(window).ToHashSet() : [];
        BringToFront(window);
        if (relocate is not null) (x, y) = relocate();
        string mechanism;
        try
        {
            switch (action)
            {
                case "click":
                {
                    Guard(window, x, y);
                    var (down, up) = Buttons[button];
                    var count = Math.Clamp(Int("count"), 1, 2);
                    var events = new List<Input> { At(0, x, y) };
                    for (var i = 0; i < count; i++) { events.Add(At(down, x, y)); events.Add(At(up, x, y)); }
                    Send(started, [.. events]);
                    moved = true;
                    mechanism = $"SendInput {button} click x{count}";
                    break;
                }
                case "wheel":
                {
                    Guard(window, x, y);
                    var (deltaY, deltaX) = (Int("deltaY"), Int("deltaX"));
                    var events = new List<Input> { At(0, x, y) };
                    if (deltaY != 0) events.Add(At(MOUSEEVENTF_WHEEL, x, y, deltaY)); // signe Windows (negatif = vers le bas), comme « point »
                    if (deltaX != 0) events.Add(At(MOUSEEVENTF_HWHEEL, x, y, deltaX));
                    Send(started, [.. events]);
                    moved = true;
                    mechanism = "SendInput wheel";
                    break;
                }
                case "drag":
                {
                    Guard(window, x, y);
                    var (tx, ty) = (Int("toX"), Int("toY"));
                    try
                    {
                        Send(started, At(0, x, y), At(MOUSEEVENTF_LEFTDOWN, x, y));
                        moved = true;
                        const int Steps = 12;
                        for (var i = 1; i <= Steps; i++)
                        {
                            Thread.Sleep(15);
                            Guard(window); // la destination peut etre une autre fenetre
                            Send(started, At(0, x + (tx - x) * i / Steps, y + (ty - y) * i / Steps));
                        }
                    }
                    finally { if (moved) Send(started, Mouse(MOUSEEVENTF_LEFTUP)); }
                    mechanism = "SendInput drag";
                    break;
                }
                case "key":
                {
                    Guard(window);
                    var downs = combo.Mods.Select(m => Key((ushort)m, false)).Append(Key((ushort)combo.Vk, false));
                    var ups = new[] { Key((ushort)combo.Vk, true) }.Concat(Enumerable.Reverse(combo.Mods).Select(m => Key((ushort)m, true)));
                    Send(started, [.. downs, .. ups]);
                    mechanism = "SendInput key";
                    break;
                }
                default: // type : unites UTF-16, sauts de ligne par Entree ; garde avant chaque caractere
                {
                    var units = text.Replace("\r\n", "\n");
                    var sent = 0;
                    try
                    {
                        foreach (var ch in units)
                        {
                            Guard(window);
                            if (ch == '\n') Send(started, Key(0x0D, false), Key(0x0D, true));
                            else Send(started, Key(0, false, ch, true), Key(0, true, ch, true));
                            sent++;
                            Thread.Sleep(2);
                        }
                    }
                    // Apres des unites envoyees : etat partiel, jamais « rien n'a ete envoye » (relecture de Codex du 22/10 12:22).
                    catch (EmergencyStopException) when (sent > 0)
                    {
                        throw new EmergencyStopException($"Emergency stop after input: {sent} of {units.Length} characters sent; outcome unknown, do not replay");
                    }
                    catch (Exception error) when (sent > 0 && error is not EmergencyStopException)
                    {
                        throw new AfterInputException($"Typing interrupted after input: {sent} of {units.Length} characters sent; outcome unknown, do not replay: {error.Message}", error);
                    }
                    mechanism = "SendInput unicode text";
                    break;
                }
            }
        }
        finally
        {
            Thread.Sleep(50);
            if (moved && Win32.GetCursorPos(out var now) && Math.Abs(now.X - (action == "drag" ? Int("toX") : x)) <= 1 &&
                Math.Abs(now.Y - (action == "drag" ? Int("toY") : y)) <= 1)
                SetCursorPos(cursor.X, cursor.Y);
        }
        return new { ok = true, technique = "physical:native", mechanism, effect = "sent", foregroundTaken = true,
            contextMenu = rightClick ? Program.OpenedMenu(window, menusBefore) : null };
    }
}
