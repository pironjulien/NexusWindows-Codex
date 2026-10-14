using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

static class Program
{
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int command);
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length != 1 || !Path.IsPathFullyQualified(args[0])) throw new ArgumentException("Absolute local evidence directory required");
        var directory = args[0];
        Directory.CreateDirectory(directory);
        var app = new Application();
        var window = new Window {
            Title = "NexusCodex — validation WPF", Width = 520, Height = 360,
            ShowActivated = false, ShowInTaskbar = true, Left = 80, Top = 80,
        };
        AutomationProperties.SetAutomationId(window, "nexus-fixture");
        var panel = new StackPanel { Margin = new Thickness(16) };
        var editor = new TextBox { AcceptsReturn = true, Height = 100, Text = "initial" };
        AutomationProperties.SetAutomationId(editor, "editor");
        AutomationProperties.SetName(editor, "Texte de validation");
        var check = new CheckBox { Content = "Option", Margin = new Thickness(0, 8, 0, 8) };
        AutomationProperties.SetAutomationId(check, "option");
        var save = new Button { Content = "Enregistrer", Height = 32 };
        AutomationProperties.SetAutomationId(save, "save");
        var status = new TextBlock { Text = "Prêt", Margin = new Thickness(0, 8, 0, 0) };
        AutomationProperties.SetAutomationId(status, "status");
        var password = new PasswordBox { Password = "fixture-only", Height = 24 };
        AutomationProperties.SetAutomationId(password, "password-fixture");
        AutomationProperties.SetName(password, "Champ protégé de validation");
        int saves = 0, edits = 0, toggles = 0;
        var initialForeground = GetForegroundWindow().ToInt64();
        void Record(string action) {
            var evidence = new { action, saves, edits, toggles, text = editor.Text, selected = check.IsChecked,
                initialForeground, foreground = GetForegroundWindow().ToInt64() };
            File.WriteAllText(Path.Combine(directory, "application-state.json"), JsonSerializer.Serialize(evidence), new UTF8Encoding(false));
        }
        editor.TextChanged += (_, _) => { edits++; Record("text-changed"); };
        check.Checked += (_, _) => { toggles++; Record("checked"); };
        check.Unchecked += (_, _) => { toggles++; Record("unchecked"); };
        save.Click += (_, _) => {
            saves++;
            File.WriteAllText(Path.Combine(directory, "saved-text.txt"), editor.Text, new UTF8Encoding(false));
            status.Text = $"Enregistré {saves}";
            Record("saved");
        };
        foreach (var item in new UIElement[] { editor, check, save, status, password }) panel.Children.Add(item);
        window.Content = panel;
        window.Loaded += (_, _) => window.Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.ApplicationIdle, new Action(() => {
            // The canonical shell launcher starts hidden; expose this test window without activation.
            ShowWindow(new System.Windows.Interop.WindowInteropHelper(window).Handle, 4); // SW_SHOWNOACTIVATE
            Record("ready");
        }));
        app.Run(window);
    }
}
