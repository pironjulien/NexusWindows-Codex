// Fixture de validation reelle : trois fenetres creees par le test lui-meme (WinForms, Win32 natif, WPF), affichees
// SANS activation et placees au fond de l'empilement (sous les fenetres de Julien). La fenetre Win32 est exactement
// sous la fenetre WinForms : elle est donc toujours recouverte. Chaque evenement applicatif est compte et ecrit dans
// state.json (preuve independante de la relecture UIA). La fixture se ferme a la fin de son entree standard, ou au
// bout de 300 s par securite.
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Forms = System.Windows.Forms;
using Wpf = System.Windows;
using WpfControls = System.Windows.Controls;
using WpfAutomation = System.Windows.Automation;

static class Program
{
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(nint hwnd, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(nint hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern nint CreateWindowExW(uint ex, string cls, string? title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);
    [DllImport("user32.dll")] static extern nint DefWindowProcW(nint hwnd, uint msg, nint wparam, nint lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern nint SendMessageW(nint hwnd, uint msg, nint wparam, string lparam);
    [DllImport("user32.dll")] static extern nint SendMessageW(nint hwnd, uint msg, nint wparam, nint lparam);
    [DllImport("user32.dll")] static extern nint CreateMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool AppendMenuW(nint menu, uint flags, nuint id, string text);
    [DllImport("user32.dll")] static extern bool SetMenu(nint hwnd, nint menu);
    [DllImport("user32.dll")] static extern bool DestroyWindow(nint hwnd);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern nint GetModuleHandleW(string? name);
    delegate nint WndProc(nint hwnd, uint msg, nint wparam, nint lparam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClass { public uint Style; public WndProc Proc; public int ClassExtra, WindowExtra; public nint Instance, Icon, Cursor, Background; public string? MenuName; public string ClassName; }

    const uint WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_TABSTOP = 0x00010000, WS_BORDER = 0x00800000, WS_VSCROLL = 0x00200000;
    const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10;
    static readonly nint HWND_BOTTOM = 1;
    static readonly object Gate = new();
    static readonly Dictionary<string, object?> State = new();
    static string evidence = "";
    static WndProc? proc;
    static nint win32Status, win32Combo, win32List, win32Check;

    static void Record(string key, object? value)
    {
        lock (Gate)
        {
            State[key] = value;
            State["foregroundAtLastEvent"] = GetForegroundWindow().ToInt64();
            var tmp = Path.Combine(evidence, "state.json.tmp");
            File.WriteAllText(tmp, JsonSerializer.Serialize(State), new UTF8Encoding(false));
            File.Move(tmp, Path.Combine(evidence, "state.json"), true);
        }
    }
    static int Count(string key) { lock (Gate) { var n = State.TryGetValue(key, out var v) && v is int i ? i + 1 : 1; Record(key, n); return n; } }

    sealed class QuietForm : Forms.Form { protected override bool ShowWithoutActivation => true; }

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 1 || !Path.IsPathFullyQualified(args[0])) { Console.Error.WriteLine("Absolute local evidence directory required"); return 2; }
        evidence = args[0];
        Directory.CreateDirectory(evidence);
        Forms.Application.EnableVisualStyles();

        // --- WinForms ---
        var form = new QuietForm { Text = "NexusCodex fixture WinForms", StartPosition = Forms.FormStartPosition.Manual, Left = 120, Top = 120, Width = 520, Height = 420, ShowInTaskbar = true };
        var name = new Forms.TextBox { Name = "nom", AccessibleName = "Nom", Left = 16, Top = 16, Width = 300 };
        var option = new Forms.CheckBox { Name = "option", Text = "Option", Left = 16, Top = 48, Width = 200 };
        var save = new Forms.Button { Name = "enregistrer", Text = "Enregistrer", Left = 16, Top = 80, Width = 140 };
        var color = new Forms.ComboBox { Name = "couleur", AccessibleName = "Couleur", DropDownStyle = Forms.ComboBoxStyle.DropDownList, Left = 16, Top = 116, Width = 200 };
        color.Items.AddRange(["Rouge", "Vert", "Bleu"]);
        var fruits = new Forms.ListBox { Name = "fruits", AccessibleName = "Fruits", Left = 16, Top = 150, Width = 200, Height = 70 };
        fruits.Items.AddRange(["Pomme", "Poire", "Prune"]);
        var openDialog = new Forms.Button { Name = "dialogue", Text = "Dialogue", Left = 240, Top = 80, Width = 140 };
        var status = new Forms.Label { Name = "etat", Text = "Prêt", Left = 16, Top = 236, Width = 400 };
        // Garde-fous : bouton d'envoi (raccourci Alt+E, bouton par defaut du formulaire), a confirmer.
        var send = new Forms.Button { Name = "envoyer", Text = "&Envoyer", Left = 330, Top = 14, Width = 140 };
        send.Click += (_, _) => status.Text = "Envoyé " + Count("winforms.sends");
        form.AcceptButton = send;
        name.TextChanged += (_, _) => { Count("winforms.textChanged"); Record("winforms.text", name.Text); };
        option.CheckedChanged += (_, _) => { Count("winforms.checkChanged"); Record("winforms.checked", option.Checked); status.Text = "Option " + (option.Checked ? "oui" : "non"); };
        save.Click += (_, _) => status.Text = "Enregistré " + Count("winforms.saves");
        color.SelectedIndexChanged += (_, _) => { Count("winforms.colorChanged"); status.Text = "Couleur " + color.SelectedItem; };
        fruits.SelectedIndexChanged += (_, _) => { Count("winforms.fruitChanged"); status.Text = "Fruit " + fruits.SelectedItem; };
        openDialog.Click += (_, _) =>
        {
            Count("winforms.dialogOpened");
            var dialog = new QuietForm { Text = "NexusCodex fixture dialogue", StartPosition = Forms.FormStartPosition.Manual, Left = 160, Top = 180, Width = 300, Height = 160, ShowInTaskbar = false };
            var close = new Forms.Button { Name = "fermer", Text = "Fermer", Left = 16, Top = 16, Width = 120 };
            close.Click += (_, _) => { Count("winforms.dialogClosed"); dialog.Close(); };
            dialog.Controls.Add(close);
            dialog.Shown += (_, _) => Record("winforms.dialog", dialog.Handle.ToInt64());
            dialog.Show(form);
        };
        form.Controls.AddRange([name, option, save, color, fruits, openDialog, status, send]);

        // --- Win32 natif (meme fil, meme boucle de messages) ---
        nint win32 = 0;
        form.Load += (_, _) => win32 = CreateWin32();

        // --- WPF (son propre fil STA) ---
        nint wpf = 0;
        Wpf.Threading.Dispatcher? wpfDispatcher = null;
        using var wpfReady = new ManualResetEventSlim();
        var wpfThread = new Thread(() =>
        {
            var window = new Wpf.Window { Title = "NexusCodex fixture WPF", Width = 420, Height = 300, ShowActivated = false, ShowInTaskbar = true, Left = 700, Top = 120, WindowStartupLocation = Wpf.WindowStartupLocation.Manual };
            var panel = new WpfControls.StackPanel { Margin = new Wpf.Thickness(12) };
            var editor = new WpfControls.TextBox { Text = "initial", Height = 60, AcceptsReturn = true };
            WpfAutomation.AutomationProperties.SetAutomationId(editor, "editeur");
            var check = new WpfControls.CheckBox { Content = "Option WPF" };
            WpfAutomation.AutomationProperties.SetAutomationId(check, "option-wpf");
            var button = new WpfControls.Button { Content = "Valider WPF" };
            WpfAutomation.AutomationProperties.SetAutomationId(button, "valider-wpf");
            var text = new WpfControls.TextBlock { Text = "Prêt" };
            var send = new WpfControls.Button { Content = "_Envoyer", IsDefault = true };
            WpfAutomation.AutomationProperties.SetAutomationId(send, "envoyer-wpf");
            send.Click += (_, _) => text.Text = "Envoyé " + Count("wpf.sends");
            WpfAutomation.AutomationProperties.SetAutomationId(text, "etat-wpf");
            editor.TextChanged += (_, _) => { Count("wpf.textChanged"); Record("wpf.text", editor.Text); };
            check.Checked += (_, _) => { Count("wpf.checked"); text.Text = "Coché"; };
            check.Unchecked += (_, _) => { Count("wpf.unchecked"); text.Text = "Décoché"; };
            button.Click += (_, _) => text.Text = "Validé " + Count("wpf.clicks");
            foreach (var element in new Wpf.UIElement[] { editor, check, button, text, send }) panel.Children.Add(element);
            window.Content = panel;
            window.SourceInitialized += (_, _) => { wpf = new Wpf.Interop.WindowInteropHelper(window).Handle; };
            window.Show();
            wpfDispatcher = Wpf.Threading.Dispatcher.CurrentDispatcher;
            wpfReady.Set();
            Wpf.Threading.Dispatcher.Run();
        });
        wpfThread.SetApartmentState(ApartmentState.STA);
        wpfThread.IsBackground = true;
        wpfThread.Start();

        form.Shown += (_, _) =>
        {
            wpfReady.Wait(10000);
            // Au fond de l'empilement, sans activation : la Win32 sous la WinForms, toutes deux sous les fenetres de Julien.
            SetWindowPos(form.Handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            SetWindowPos(win32, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            if (wpf != 0) SetWindowPos(wpf, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            var ready = new { pid = Environment.ProcessId, winforms = form.Handle.ToInt64(), win32 = win32.ToInt64(), wpf = wpf.ToInt64(), foreground = GetForegroundWindow().ToInt64() };
            File.WriteAllText(Path.Combine(evidence, "ready.json"), JsonSerializer.Serialize(ready), new UTF8Encoding(false));
        };

        // Fin : entree standard fermee (test termine ou mort), ou securite de 300 s.
        var stdin = Task.Run(() => Console.In.ReadToEnd());
        Task.WhenAny(stdin, Task.Delay(300000)).ContinueWith(_ => form.BeginInvoke(() =>
        {
            wpfDispatcher?.InvokeShutdown();
            if (win32 != 0) DestroyWindow(win32);
            Forms.Application.Exit();
        }));
        Forms.Application.Run(form);
        return 0;
    }

    static nint CreateWin32()
    {
        proc = Win32Proc;
        var instance = GetModuleHandleW(null);
        var wc = new WndClass { Proc = proc, Instance = instance, ClassName = "NexusCodexFixtureWin32", Background = 16 /* COLOR_BTNFACE + 1 */ };
        RegisterClassW(ref wc);
        var top = CreateWindowExW(0, wc.ClassName, "NexusCodex fixture Win32", WS_OVERLAPPEDWINDOW, 120, 120, 520, 420, 0, 0, instance, 0);
        nint Child(string cls, string? text, uint style, int x, int y, int w, int h, int id) =>
            CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | style, x, y, w, h, top, id, instance, 0);
        Child("BUTTON", "Valider", 0x0 /* BS_PUSHBUTTON */, 16, 16, 120, 28, 101);
        win32Check = Child("BUTTON", "Activer", 0x3 /* BS_AUTOCHECKBOX */, 16, 52, 160, 24, 102);
        Child("EDIT", "", WS_BORDER | 0x80 /* ES_AUTOHSCROLL */, 16, 84, 300, 24, 103);
        win32Combo = Child("COMBOBOX", null, 0x3 /* CBS_DROPDOWNLIST */ | WS_VSCROLL, 16, 116, 200, 200, 104);
        foreach (var item in new[] { "Alpha", "Bravo", "Charlie" }) SendMessageW(win32Combo, 0x0143 /* CB_ADDSTRING */, 0, item);
        win32List = Child("LISTBOX", null, 0x1 /* LBS_NOTIFY */ | WS_BORDER | WS_VSCROLL, 16, 150, 200, 70, 105);
        foreach (var item in new[] { "Un", "Deux", "Trois" }) SendMessageW(win32List, 0x0180 /* LB_ADDSTRING */, 0, item);
        win32Status = Child("STATIC", "Prêt", 0, 16, 236, 400, 24, 106);
        Child("BUTTON", "&Envoyer", 0x1 /* BS_DEFPUSHBUTTON */, 330, 84, 120, 28, 107);
        var menu = CreateMenu();
        var file = CreateMenu();
        AppendMenuW(file, 0, 201, "&Compter\tCtrl+K");
        AppendMenuW(file, 0x1 /* MF_GRAYED */, 202, "&Désactivé");
        AppendMenuW(file, 0, 203, "En&voyer");
        AppendMenuW(menu, 0x10 /* MF_POPUP */, (nuint)file, "&Fichier");
        SetMenu(top, menu);
        ShowWindow(top, 4 /* SW_SHOWNOACTIVATE */);
        return top;
    }

    static string TextOf(nint hwnd, uint lengthMsg, uint textMsg, nint index)
    {
        var length = (int)SendMessageW(hwnd, lengthMsg, index, 0);
        if (length < 0) return "";
        var chars = new char[length + 1];
        var handle = GCHandle.Alloc(chars, GCHandleType.Pinned);
        try { SendMessageW(hwnd, textMsg, index, handle.AddrOfPinnedObject()); } finally { handle.Free(); }
        return new string(chars, 0, length);
    }

    static nint Win32Proc(nint hwnd, uint msg, nint wparam, nint lparam)
    {
        if (msg == 0x0111 /* WM_COMMAND */)
        {
            var id = (int)(wparam & 0xFFFF);
            var code = (int)((wparam >> 16) & 0xFFFF);
            switch (id)
            {
                case 101 when code == 0: SetWindowTextW(win32Status, "Valider " + Count("win32.valider")); break;
                case 102 when code == 0:
                {
                    var on = SendMessageW(win32Check, 0x00F0 /* BM_GETCHECK */, 0, 0) == 1;
                    Count("win32.activer"); Record("win32.checked", on);
                    SetWindowTextW(win32Status, "Activer " + (on ? "oui" : "non"));
                    break;
                }
                case 103 when code == 0x300 /* EN_CHANGE */: Count("win32.editChanged"); break;
                case 104 when code == 1 /* CBN_SELCHANGE */:
                {
                    var index = SendMessageW(win32Combo, 0x0147 /* CB_GETCURSEL */, 0, 0);
                    var text = TextOf(win32Combo, 0x0149, 0x0148, index);
                    Count("win32.comboChanged"); SetWindowTextW(win32Status, "Choix " + text);
                    break;
                }
                case 105 when code == 1 /* LBN_SELCHANGE */:
                {
                    var index = SendMessageW(win32List, 0x0188 /* LB_GETCURSEL */, 0, 0);
                    var text = TextOf(win32List, 0x018A, 0x0189, index);
                    Count("win32.listChanged"); SetWindowTextW(win32Status, "Liste " + text);
                    break;
                }
                case 201 when lparam == 0: SetWindowTextW(win32Status, "Compter " + Count("win32.menu")); break;
                case 202 when lparam == 0: Count("win32.disabledMenu"); break;
                case 107 when code == 0: SetWindowTextW(win32Status, "Envoyé " + Count("win32.sends")); break;
                case 203 when lparam == 0: SetWindowTextW(win32Status, "Menu envoyé " + Count("win32.menuSends")); break;
            }
        }
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
}
