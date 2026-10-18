// Formulaires du banc réel du 16/10/2026 (mêmes champs que NexusAGY/tests/desktop_fixtures.py), hébergés par
// powershell.exe (.NET Framework, WinForms et WPF) comme au banc : champs Nom, Email, Ville ; case « Accepter » ;
// liste déroulante « Formule » (Alpha, Bravo, Charlie) ; bouton « Valider » qui écrit dans l'étiquette « resultat » ce
// que l'APPLICATION a reçu, avec le nombre d'envois. Affichés SANS activation, au fond de l'empilement, fermés à la fin
// de leur entrée standard (ou au bout de 300 s). Le processus WinForms crée aussi une fenêtre de classe
// « ConsoleWindowClass » (fausse console) : libre depuis l'accord « garde-fous » du 18/10, comme le formulaire.
import { spawn } from 'node:child_process';

const WINFORMS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public class NexusBenchForm : Form {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    protected override bool ShowWithoutActivation { get { return true; } }
    int sends = 0;
    TextBox Field(string name, int y) {
        var l = new Label(); l.Text = name + " :"; l.Location = new Point(20, y + 4); l.Size = new Size(70, 22); Controls.Add(l);
        var t = new TextBox(); t.Location = new Point(100, y); t.Size = new Size(240, 26); t.AccessibleName = name; t.Name = name;
        Controls.Add(t); return t;
    }
    public NexusBenchForm() {
        Text = "NexusCodex banc WinForms"; StartPosition = FormStartPosition.Manual; Location = new Point(140, 140); Size = new Size(640, 420);
        var nom = Field("Nom", 20); var email = Field("Email", 56); var ville = Field("Ville", 92);
        var c = new CheckBox(); c.Text = "Accepter"; c.Location = new Point(100, 130); c.Size = new Size(180, 26); Controls.Add(c);
        var cb = new ComboBox(); cb.DropDownStyle = ComboBoxStyle.DropDownList; cb.Location = new Point(100, 166); cb.Size = new Size(200, 26);
        cb.Items.AddRange(new object[] { "Alpha", "Bravo", "Charlie" }); cb.AccessibleName = "Formule"; Controls.Add(cb);
        var res = new Label(); res.Name = "resultat"; res.Text = "Résultat : "; res.Location = new Point(20, 260); res.Size = new Size(600, 26); res.AutoSize = false; Controls.Add(res);
        var b = new Button(); b.Text = "Valider"; b.Location = new Point(100, 206); b.Size = new Size(140, 32);
        b.Click += (s, e) => {
            sends++;
            res.Text = "Résultat : Nom=" + nom.Text + ";Email=" + email.Text + ";Ville=" + ville.Text + ";Accepter=" + (c.Checked ? "oui" : "non") + ";Formule=" + cb.SelectedItem + ";Envois=" + sends;
        };
        Controls.Add(b);
        var safety = new System.Windows.Forms.Timer(); safety.Interval = 300000; safety.Tick += (s, e) => Close(); safety.Start();
        var watcher = new Thread(() => { Console.In.ReadToEnd(); try { BeginInvoke(new MethodInvoker(Close)); } catch (Exception) { } });
        watcher.IsBackground = true; watcher.Start();
    }
}
public static class NexusFakeConsole {
    delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClass { public uint Style; public WndProc Proc; public int ClassExtra, WindowExtra; public IntPtr Instance, Icon, Cursor, Background; public string MenuName; public string ClassName; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    static readonly WndProc proc = DefWindowProcW;
    public static IntPtr Create() {
        var wc = new WndClass(); wc.Proc = proc; wc.Instance = GetModuleHandleW(null); wc.ClassName = "ConsoleWindowClass";
        RegisterClassW(ref wc);
        var h = CreateWindowExW(0x08000000 /* WS_EX_NOACTIVATE */, "ConsoleWindowClass", "NexusCodex fausse console", 0x00CF0000, 160, 160, 260, 120, IntPtr.Zero, IntPtr.Zero, wc.Instance, IntPtr.Zero);
        ShowWindow(h, 4 /* SW_SHOWNOACTIVATE */);
        NexusBenchForm.SetWindowPos(h, (IntPtr)1, 0, 0, 0, 0, 0x0013);
        return h;
    }
}
'@
$form = New-Object NexusBenchForm
$form.add_FormClosed({ [System.Windows.Forms.Application]::ExitThread() })
$form.Show()
[void][NexusBenchForm]::SetWindowPos($form.Handle, [IntPtr]1, 0, 0, 0, 0, 0x0013)
$console = [NexusFakeConsole]::Create()
[Console]::Out.WriteLine((@{ hwnd = $form.Handle.ToInt64(); console = $console.ToInt64() } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run()
`;

const WPF = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -ReferencedAssemblies ([System.Windows.Threading.Dispatcher].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Threading;
public static class NexusWpfBench {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public static void ShutdownOnStdinEnd(Dispatcher dispatcher) {
        var watcher = new Thread(() => { Console.In.ReadToEnd(); dispatcher.BeginInvokeShutdown(DispatcherPriority.Normal); });
        watcher.IsBackground = true; watcher.Start();
        var safety = new DispatcherTimer(TimeSpan.FromSeconds(300), DispatcherPriority.Normal, (s, e) => dispatcher.BeginInvokeShutdown(DispatcherPriority.Normal), dispatcher);
        safety.Start();
    }
}
'@
$script:sends = 0
$w = New-Object System.Windows.Window
$w.Title = 'NexusCodex banc WPF'
$w.ShowActivated = $false
$w.WindowStartupLocation = 'Manual'
$w.Left = 180; $w.Top = 160; $w.Width = 560; $w.Height = 440
$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = '12'
function New-Field([string]$name) {
    $row = New-Object System.Windows.Controls.StackPanel
    $row.Orientation = 'Horizontal'; $row.Margin = '2'
    $label = New-Object System.Windows.Controls.Label
    $label.Content = "$name :"; $label.Width = 80
    $box = New-Object System.Windows.Controls.TextBox
    $box.Width = 260
    [System.Windows.Automation.AutomationProperties]::SetName($box, $name)
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($box, $name)
    [void]$row.Children.Add($label); [void]$row.Children.Add($box); [void]$panel.Children.Add($row)
    return $box
}
$nom = New-Field 'Nom'; $email = New-Field 'Email'; $ville = New-Field 'Ville'
$check = New-Object System.Windows.Controls.CheckBox
$check.Content = 'Accepter'; $check.Margin = '84,6,0,6'
[void]$panel.Children.Add($check)
$combo = New-Object System.Windows.Controls.ComboBox
$combo.Width = 200; $combo.HorizontalAlignment = 'Left'; $combo.Margin = '84,2,0,6'
[System.Windows.Automation.AutomationProperties]::SetName($combo, 'Formule')
foreach ($o in 'Alpha', 'Bravo', 'Charlie') { [void]$combo.Items.Add($o) }
[void]$panel.Children.Add($combo)
$button = New-Object System.Windows.Controls.Button
$button.Content = 'Valider'; $button.Width = 140; $button.HorizontalAlignment = 'Left'; $button.Margin = '84,6,0,6'
[void]$panel.Children.Add($button)
$result = New-Object System.Windows.Controls.TextBlock
$result.Text = 'Résultat : '; $result.Margin = '0,10,0,0'
[System.Windows.Automation.AutomationProperties]::SetAutomationId($result, 'resultat')
[void]$panel.Children.Add($result)
$button.Add_Click({
    $script:sends++
    $accept = if ($check.IsChecked) { 'oui' } else { 'non' }
    $result.Text = "Résultat : Nom=$($nom.Text);Email=$($email.Text);Ville=$($ville.Text);Accepter=$accept;Formule=$($combo.SelectedItem);Envois=$($script:sends)"
})
$w.Content = $panel
$w.Add_Closed({ $w.Dispatcher.InvokeShutdown() })
$w.Show()
$handle = (New-Object System.Windows.Interop.WindowInteropHelper $w).Handle
[void][NexusWpfBench]::SetWindowPos($handle, [IntPtr]1, 0, 0, 0, 0, 0x0013)
[NexusWpfBench]::ShutdownOnStdinEnd($w.Dispatcher)
[Console]::Out.WriteLine((@{ hwnd = $handle.ToInt64() } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
[System.Windows.Threading.Dispatcher]::Run()
`;

// Windows PowerShell en STA, script encodé (aucun fichier écrit), sans console visible.
export async function startBenchForm(kind, timeoutMs = 45000) {
  const script = kind === 'wpf' ? WPF : WINFORMS;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
  child.stdout.setEncoding('utf8');
  const info = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Formulaire ${kind} non créé : ${stderr.slice(-800)}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find(l => l.trim().startsWith('{'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`Formulaire ${kind} fermé (code ${code}) : ${stderr.slice(-800)}`)); });
  });
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited; clearTimeout(timer);
  };
  return { pid: child.pid, ...info, close };
}
