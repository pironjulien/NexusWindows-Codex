using System.IO;
using System.Runtime.InteropServices;

// Navigation d'une fenetre de l'Explorateur vers un dossier, en arriere-plan, par le shell de Windows (ShellWindows,
// Navigate2) : ni clavier ni premier plan. Passe 2 du 22/10 : Ctrl+L n'avait pas le focus en arriere-plan, et le premier
// plan rendu entre deux lectures faisait perdre la saisie de la barre d'adresse.
// Gardes (relecture de Codex du 23/10) : inventaire COMPLET des vues du shell (une vue illisible : refus, l'unicite ne
// serait pas prouvee) ; fenetre a UN seul onglet (sinon l'onglet vise serait devine, et il peut etre celui de Julien) ;
// rattachement vue/HWND relu juste avant l'envoi et a chaque relecture d'arrivee ; dossiers compares par leur identite
// sur le disque (volume + identifiant de fichier), jamais par une casse normalisee (repertoires sensibles a la casse).
static class Explorer
{
    public static object Navigate(nint hwnd, string path, Action inputStarted)
    {
        if (!Path.IsPathFullyQualified(path) || !Directory.Exists(path))
            throw new ActionRefusedException("The folder must be an existing absolute path; nothing was sent");
        var wanted = Identity(path) ?? throw new ActionRefusedException("The folder identity cannot be read; nothing was sent");
        var tab = SingleTab(hwnd);
        if (Current(tab) is { } before && Identity(before) == wanted)
        {
            // Rattachement relu APRES les lectures : le succes concerne bien la fenetre liee (relecture de Codex).
            if (!Attached(tab, hwnd)) throw new ActionRefusedException("The Explorer view changed while reading it; nothing was sent");
            return new { ok = true, technique = "background:shell", mechanism = "Navigate2", effect = "already", path = (string?)before, note = (string?)null };
        }
        // Rattachement relu juste avant l'envoi : meme vue, toujours seule vue de CETTE fenetre ; puis STOP relu en
        // DERNIER, l'inventaire COM pouvant attendre (relecture de Codex).
        if (!SameView(SingleTab(hwnd), tab)) throw new ActionRefusedException("The Explorer view changed before input; nothing was sent");
        // L'inventaire a pu attendre apres avoir lu ce HWND : rattachement de la vue relu en dernier (relecture de Codex).
        if (!Attached(tab, hwnd)) throw new ActionRefusedException("The Explorer view changed before input; nothing was sent");
        EmergencyStop.ThrowIfStopped();
        inputStarted();
        ((dynamic)tab).Navigate2(path);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 4000)
        {
            var shown = Current(tab);
            var arrived = shown is not null && Identity(shown) == wanted;
            // Rattachement relu APRES les lectures qui fondent le succes : perdu, issue inconnue, jamais rejouee.
            if (!Attached(tab, hwnd))
                return new { ok = true, technique = "background:shell", mechanism = "Navigate2", effect = "sent", path = (string?)null, note = (string?)"view no longer attached to the bound window" };
            if (arrived)
                return new { ok = true, technique = "background:shell", mechanism = "Navigate2", effect = "verified", path = shown, note = (string?)null };
            Thread.Sleep(50);
        }
        return new { ok = true, technique = "background:shell", mechanism = "Navigate2", effect = "sent", path = Current(tab), note = (string?)null };
    }

    static object SingleTab(nint hwnd)
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Shell.Application is unavailable");
        dynamic shell = Activator.CreateInstance(shellType)!;
        var tabs = new List<object>();
        foreach (object view in shell.Windows())
        {
            var handle = HwndOf(view) ?? throw new ActionRefusedException("A shell view could not be read: the tabs of this window cannot be counted; nothing was sent");
            if (handle == (long)hwnd) tabs.Add(view);
        }
        if (tabs.Count == 0) throw new BackgroundNotApplicableException("This window is not a shell folder window");
        if (tabs.Count > 1) throw new ActionRefusedException($"This Explorer window holds {tabs.Count} tabs: the tab to navigate would be guessed; nothing was sent");
        return tabs[0];
    }

    static bool Attached(object view, nint hwnd) => HwndOf(view) == (long)hwnd;

    static long? HwndOf(object view)
    {
        try { return (long)((dynamic)view).HWND; } catch { return null; }
    }

    // Meme objet COM (identite IUnknown), pas seulement meme dossier.
    static bool SameView(object a, object b)
    {
        var ua = Marshal.GetIUnknownForObject(a);
        var ub = Marshal.GetIUnknownForObject(b);
        try { return ua == ub; } finally { Marshal.Release(ua); Marshal.Release(ub); }
    }

    static string? Current(object tab)
    {
        try { return (string)((dynamic)tab).Document.Folder.Self.Path; } catch { return null; }
    }

    // Identite d'un dossier sur le disque : FILE_ID_INFO (volume 64 bits + identifiant 128 bits), unique y compris sur
    // ReFS, ou l'index 64 bits de BY_HANDLE_FILE_INFORMATION ne l'est pas (relecture de Codex). Illisible : null, et
    // l'appelant refuse (ferme).
    static (ulong Volume, ulong Low, ulong High)? Identity(string path)
    {
        using var handle = CreateFile(path, 0, 7, 0, 3, 0x02000000, 0); // OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS
        if (handle.IsInvalid || !GetFileInformationByHandleEx(handle, 18, out var info, (uint)Marshal.SizeOf<FileIdInfo>())) return null; // FileIdInfo
        return (info.VolumeSerialNumber, info.IdLow, info.IdHigh);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileIdInfo
    {
        public ulong VolumeSerialNumber;
        public ulong IdLow, IdHigh; // FILE_ID_128
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int infoClass, out FileIdInfo info, uint size);
}
