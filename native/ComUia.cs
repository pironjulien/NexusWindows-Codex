using System.Runtime.InteropServices;

// Client COM UI Automation (CUIAutomation8 / IUIAutomation2) : lecture de l'arbre ET motifs d'arriere-plan.
// Le client gere de System.Windows.Automation n'est plus charge nulle part : il n'expose pas AutoSetFocus (par defaut,
// UIA donne le focus a l'element avant un motif, ce qui active la fenetre cible) et il lit l'arbre propriete par
// propriete (un aller-retour inter-processus par propriete et par element). Ici AutoSetFocus = FALSE, relu apres
// reglage, et l'arbre est lu en UN aller-retour (CacheRequest, portee Subtree, vue Controle).
// Appels par emplacements de table virtuelle (ordre de UIAutomationClient.h, Windows SDK 10.0.26100) : aucune
// bibliotheque d'interop ni typelib a generer.
unsafe sealed class ComUia
{
    static readonly Guid ClsidCUIAutomation8 = new("e22ad333-b25f-460c-83d0-0581107395c9");
    static readonly Guid IidIUIAutomation2 = new("34723aff-0c9d-49d0-9896-7ab52df8cd8a");
    static readonly Guid IidInvoke = new("fb377fbe-8ea6-46d5-9c73-6499642d3059");
    static readonly Guid IidToggle = new("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70");
    static readonly Guid IidValue = new("a94cd8b1-0844-4cd6-9d2d-640537ab39e9");
    static readonly Guid IidSelectionItem = new("a8efa66a-0fda-421a-9194-38021f3578ea");
    static readonly Guid IidExpandCollapse = new("619be086-1f4e-4ee4-bafa-210128738730");
    static readonly Guid IidSelection = new("5ed5202e-b2ac-47a6-b638-4b0bf140d78e");
    static readonly Guid IidText = new("32eba289-3583-42c9-9c59-3b6d9a1e9b6a");
    static readonly Guid IidScroll = new("88f4d42a-e881-459d-a77c-73bbbb7e02dc");
    static readonly Guid IidLegacy = new("828055ad-355b-4435-86d5-3b51c14a9b1b");
    static readonly Guid IidScrollItem = new("b488300f-d015-4f19-9c29-bb595e3645ef");
    public const int InvokePatternId = 10000, SelectionPatternId = 10001, ValuePatternId = 10002, ExpandCollapsePatternId = 10005,
        SelectionItemPatternId = 10010, TextPatternId = 10014, TogglePatternId = 10015, ScrollPatternId = 10004,
        ScrollItemPatternId = 10017, LegacyIAccessiblePatternId = 10018;
    const int RuntimeIdProperty = 30000, BoundingRectangleProperty = 30001, ProcessIdProperty = 30002, ControlTypeProperty = 30003,
        NameProperty = 30005, AccessKeyProperty = 30007, HasKeyboardFocusProperty = 30008, LegacyIAccessibleStateProperty = 30096, IsEnabledProperty = 30010, AutomationIdProperty = 30011,
        HelpTextProperty = 30013, IsPasswordProperty = 30019, NativeWindowHandleProperty = 30020, IsOffscreenProperty = 30022, FrameworkIdProperty = 30024,
        IsExpandCollapseAvailable = 30028, IsInvokeAvailable = 30031, IsSelectionItemAvailable = 30036, IsSelectionAvailable = 30037,
        IsTextAvailable = 30040, IsToggleAvailable = 30041, IsValueAvailable = 30043, ValueValueProperty = 30045,
        ExpandCollapseStateProperty = 30070, SelectionItemIsSelectedProperty = 30079, ToggleStateProperty = 30086;
    static readonly int[] TreeProperties =
    [
        RuntimeIdProperty, BoundingRectangleProperty, ProcessIdProperty, ControlTypeProperty, NameProperty, HasKeyboardFocusProperty,
        IsEnabledProperty, AutomationIdProperty, HelpTextProperty, IsPasswordProperty, NativeWindowHandleProperty, IsOffscreenProperty, FrameworkIdProperty,
        IsExpandCollapseAvailable, IsInvokeAvailable, IsSelectionItemAvailable, IsSelectionAvailable, IsTextAvailable, IsToggleAvailable,
        IsValueAvailable, ValueValueProperty, ExpandCollapseStateProperty, SelectionItemIsSelectedProperty, ToggleStateProperty,
        AccessKeyProperty, LegacyIAccessibleStateProperty, // garde-fous : raccourci Alt et bouton par defaut (STATE_SYSTEM_DEFAULT)
    ];
    const int TreeScopeElement = 1, TreeScopeChildren = 2, TreeScopeSubtree = 7;
    const ushort VT_I4 = 3, VT_R8 = 5, VT_BSTR = 8, VT_BOOL = 11, VT_ARRAY = 0x2000;
    public const int MaxNodes = 4096, MaxDepth = 64, MaxText = 32768;

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct Variant
    {
        [FieldOffset(0)] public ushort Vt;
        [FieldOffset(8)] public nint Pointer;
        [FieldOffset(8)] public int Int;
        [FieldOffset(8)] public short Bool;
    }

    [DllImport("ole32.dll")] static extern int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint instance);
    [DllImport("oleaut32.dll")] static extern nint SafeArrayCreateVector(ushort vt, int lowerBound, uint count);
    [DllImport("oleaut32.dll")] static extern int SafeArrayAccessData(nint array, out nint data);
    [DllImport("oleaut32.dll")] static extern int SafeArrayUnaccessData(nint array);
    [DllImport("oleaut32.dll")] static extern int SafeArrayGetLBound(nint array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] static extern int SafeArrayGetUBound(nint array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] static extern int VariantClear(ref Variant value);

    static ComUia? shared;
    readonly nint automation, treeRequest, elementRequest, childrenRequest, walker;
    public static ComUia Shared => shared ??= new ComUia();

    ComUia()
    {
        // Une VARIANT de 24 octets suppose un processus 64 bits (x64, ARM64).
        if (!Environment.Is64BitProcess) throw new BackgroundNotApplicableException("COM UI Automation requires a 64-bit helper");
        Check(CoCreateInstance(ClsidCUIAutomation8, 0, 1 /* CLSCTX_INPROC_SERVER */, IidIUIAutomation2, out automation));
        var vtable = *(nint**)automation;
        Check(((delegate* unmanaged[Stdcall]<nint, int, int>)vtable[59])(automation, 0));            // put_AutoSetFocus(FALSE)
        Check(((delegate* unmanaged[Stdcall]<nint, uint, int>)vtable[61])(automation, 2000));         // put_ConnectionTimeout
        Check(((delegate* unmanaged[Stdcall]<nint, uint, int>)vtable[63])(automation, 5000));         // put_TransactionTimeout
        int autoSetFocus;
        Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)vtable[58])(automation, &autoSetFocus)); // get_AutoSetFocus
        if (autoSetFocus != 0) throw new BackgroundNotApplicableException("UI Automation refused AutoSetFocus = FALSE");
        treeRequest = Request(TreeScopeSubtree);
        elementRequest = Request(TreeScopeElement);
        childrenRequest = Request(TreeScopeChildren);
        nint w;
        Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)vtable[14])(automation, &w));          // get_ControlViewWalker
        walker = w;
    }
    // Demande de cache : toutes les proprietes lues par l'inspection, vue Controle, elements complets (motifs courants
    // encore appelables ensuite).
    nint Request(int scope)
    {
        nint request, condition;
        Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(automation)[20])(automation, &request));  // CreateCacheRequest
        foreach (var property in TreeProperties) Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Vt(request)[3])(request, property));
        Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Vt(request)[7])(request, scope));                // put_TreeScope
        Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(automation)[18])(automation, &condition)); // get_ControlViewCondition
        try { Check(((delegate* unmanaged[Stdcall]<nint, nint, int>)Vt(request)[9])(request, condition)); } // put_TreeFilter
        finally { Release(condition); }
        return request;
    }

    public static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    static nint* Vt(nint unknown) => *(nint**)unknown;
    public static void Release(nint unknown) { if (unknown != 0) ((delegate* unmanaged[Stdcall]<nint, uint>)Vt(unknown)[2])(unknown); }

    nint ElementFromHandle(nint hwnd)
    {
        nint element;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(automation)[6])(automation, hwnd, &element));
        if (element == 0) throw new BackgroundNotApplicableException("No UI Automation element for the window");
        return element;
    }
    nint Condition(int property, Variant value)
    {
        nint condition;
        try { Check(((delegate* unmanaged[Stdcall]<nint, int, Variant, nint*, int>)Vt(automation)[23])(automation, property, value, &condition)); }
        finally { VariantClear(ref value); }
        return condition;
    }
    nint RuntimeIdCondition(int[] runtimeId)
    {
        var array = SafeArrayCreateVector(VT_I4, 0, (uint)runtimeId.Length);
        if (array == 0) throw new OutOfMemoryException();
        Check(SafeArrayAccessData(array, out var data));
        Marshal.Copy(runtimeId, 0, data, runtimeId.Length);
        Check(SafeArrayUnaccessData(array));
        return Condition(RuntimeIdProperty, new Variant { Vt = VT_ARRAY | VT_I4, Pointer = array });
    }
    static nint FindFirst(nint scopeRoot, nint condition)
    {
        nint found;
        Check(((delegate* unmanaged[Stdcall]<nint, int, nint, nint*, int>)Vt(scopeRoot)[5])(scopeRoot, TreeScopeSubtree, condition, &found));
        return found;
    }
    bool Same(nint a, nint b)
    {
        int same;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, int*, int>)Vt(automation)[3])(automation, a, b, &same));
        return same != 0;
    }

    // Element courant d'identite d'execution donnee, sous la fenetre. Le resultat est a liberer (Release). Indice de
    // fenetre propre (controles Win32/WinForms) : l'element est pris directement sur sa fenetre si son identite
    // concorde, sans parcourir l'arbre (un parcours traverserait une liste deroulante ouverte, voir ReadTree).
    public nint FindByRuntimeId(nint window, int[] runtimeId, nint hint = 0)
    {
        if (FromHint(hint, runtimeId, 0) is var direct and not 0) return direct;
        var root = ElementFromHandle(window);
        try
        {
            var condition = RuntimeIdCondition(runtimeId);
            try
            {
                var found = FindFirst(root, condition);
                if (found == 0) throw new BackgroundNotApplicableException("Target is no longer present for UI Automation");
                return found;
            }
            finally { Release(condition); }
        }
        finally { Release(root); }
    }
    nint FromHint(nint hint, int[] runtimeId, nint request)
    {
        if (hint == 0 || !Win32.IsWindow(hint)) return 0;
        nint element;
        var hr = request == 0
            ? ((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(automation)[6])(automation, hint, &element)
            : ((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Vt(automation)[10])(automation, hint, request, &element);
        if (hr < 0 || element == 0) return 0;
        var same = (request == 0 ? CurrentRuntimeId(element) : CachedIntArray(element, RuntimeIdProperty))?.SequenceEqual(runtimeId) == true;
        if (same) return element;
        Release(element);
        return 0;
    }
    static int[]? CurrentRuntimeId(nint element)
    {
        nint array;
        if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(element)[4])(element, &array) < 0 || array == 0) return null; // GetRuntimeId
        try { return ReadArray<int>(array); } finally { SafeArrayDestroy(array); }
    }
    [DllImport("oleaut32.dll")] static extern int SafeArrayDestroy(nint array);

    // ---- Lecture de l'arbre ------------------------------------------------------------------------------------------
    // Un seul aller-retour (portee Subtree). Exception mesuree : une liste deroulante Win32/WinForms OUVERTE rend son
    // sous-arbre UIA pathologique (proxy WinForms .NET Framework : « Malformed Cacheresponse » apres ~7 s, puis la
    // navigation vers ses enfants ne repond plus). Les listes deroulantes classiques ne sont donc jamais parcourues par
    // UIA : leurs options sont lues par messages (CB_GETCOUNT, CB_GETLBTEXT, CB_GETCURSEL), ouvertes ou non, en noeuds
    // synthetiques (identite d'execution [-1, fenetre, genre, rang]). Si l'une d'elles est ouverte, la lecture se fait
    // niveau par niveau (un aller-retour par element qui a des enfants) pour ne pas entrer dans son sous-arbre.
    public UiTree ReadTree(nint hwnd, bool withPopups = true)
    {
        var levels = false;
        Win32.EnumChildWindows(hwnd, (child, _) =>
        {
            if (Win32.BaseClass(child) == "combobox" && Win32.Send(child, Win32.CB_GETDROPPEDSTATE) is > 0) { levels = true; return false; }
            return true;
        }, 0);
        nint root;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Vt(automation)[10])(automation, hwnd, levels ? elementRequest : treeRequest, &root)); // ElementFromHandleBuildCache
        if (root == 0) throw new InvalidOperationException("No UI Automation root");
        var tree = new UiTree();
        // Chaque element appartient soit a la pile (pas encore decrit), soit a l'arbre : libere une seule fois.
        var pending = new Stack<(nint Element, int Depth, int[] Ancestors)>();
        pending.Push((root, 0, []));
        // Menu contextuel ou deroulant WinForms ouvert (ContextMenuStrip : fenetre de premier niveau, hors de l'arbre UIA de
        // la fenetre ; banc commun du 21/10 : « found 0 » pour « Copier ») : son sous-arbre est lu sous la racine, sa racine
        // portant le HWND de la surgissante (nativeWindow), qui devient la portee des commandes de ce menu.
        var popups = new Queue<nint>(withPopups ? Win32.LinkedMenuPopups(hwnd) : []);
        try
        {
            while (pending.Count > 0 || popups.Count > 0)
            {
                if (pending.Count == 0)
                {
                    var popup = popups.Dequeue();
                    // Deja lue sous la fenetre : une fois possedee par le formulaire (apres sa premiere ouverture), UIA la
                    // range parmi ses enfants ; relue ici, chaque commande apparaissait deux fois (banc du 22/10 :
                    // « found 2 » pour « Copier » au second tour).
                    if (tree.Nodes.Any(n => n.NativeWindow == popup)) continue;
                    nint popupRoot;
                    Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Vt(automation)[10])(automation, popup, treeRequest, &popupRoot));
                    if (popupRoot == 0) throw new InvalidOperationException("Open menu could not be read");
                    pending.Push((popupRoot, 1, [0]));
                    continue;
                }
                var (element, depth, ancestors) = pending.Peek();
                if (tree.Nodes.Count >= MaxNodes || depth > MaxDepth)
                    throw new InvalidOperationException("Accessibility tree exceeds inspection bound; target a smaller window");
                var node = Describe(element, depth, ancestors);
                pending.Pop();
                tree.Add(node);
                if (IsClassicCombo(node))
                {
                    if (!levels) foreach (var child in CachedChildren(element)) Release(child);
                    SynthesizeCombo(tree, node);
                    continue;
                }
                if (IsClassicListBox(node))
                {
                    if (!levels) foreach (var child in CachedChildren(element)) Release(child);
                    SynthesizeListBox(tree, node);
                    continue;
                }
                var children = levels ? Children(element) : CachedChildren(element);
                // Ordre du document : premier enfant traite en premier.
                for (var i = children.Count - 1; i >= 0; i--) pending.Push((children[i], depth + 1, [.. ancestors, node.Index]));
            }
            return tree;
        }
        catch
        {
            while (pending.Count > 0) Release(pending.Pop().Element);
            tree.Dispose();
            throw;
        }
    }
    // Enfants (vue Controle) avec leurs proprietes en cache, en un aller-retour.
    List<nint> Children(nint element)
    {
        nint updated;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(element)[9])(element, childrenRequest, &updated)); // BuildUpdatedCache
        try { return CachedChildren(updated); } finally { Release(updated); }
    }
    static List<nint> CachedChildren(nint element)
    {
        nint array;
        Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(element)[19])(element, &array)); // GetCachedChildren
        var children = new List<nint>();
        if (array == 0) return children;
        try
        {
            int length;
            Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(array)[3])(array, &length));
            for (var i = 0; i < length; i++)
            {
                nint child;
                Check(((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Vt(array)[4])(array, i, &child));
                if (child != 0) children.Add(child);
            }
        }
        finally { Release(array); }
        return children;
    }

    // Liste deroulante Win32/WinForms (classe COMBOBOX, hors CBS_SIMPLE).
    public static bool IsClassicCombo(Node node) => node.Role == "combobox" && node.NativeWindow != 0 && node.FrameworkId is "Win32" or "WinForm" &&
        Win32.BaseClass(node.NativeWindow) == "combobox" && (Win32.Style(node.NativeWindow) & 0x3) != 0x1;
    public const int Synthetic = -1, SyntheticList = 1, SyntheticItem = 2, SyntheticEdit = 3;
    // Liste WinForms a selection simple (classe LISTBOX) : ses elements UIA n'ont pas d'identite stable (banc commun du
    // 21/10 : « Target is no longer present » au clic) ; ils sont lus par messages, comme les options d'une liste deroulante.
    // Seulement une liste simple : ni selection multiple, ni dessinee par l'application (CheckedListBox, listes owner-draw :
    // LB_GETTEXT y rend les donnees de l'element, pas le libelle ; cases a cocher perdues) - relecture de Codex.
    public static bool IsClassicListBox(Node node) => node.Role == "list" && node.NativeWindow != 0 && node.FrameworkId == "WinForm" &&
        Win32.BaseClass(node.NativeWindow) == "listbox" &&
        (Win32.Style(node.NativeWindow) & (Win32.LBS_MULTIPLESEL | Win32.LBS_EXTENDEDSEL | 0x10 | 0x20)) == 0; // + LBS_OWNERDRAWFIXED/VARIABLE
    public static void SynthesizeListBox(UiTree tree, Node list)
    {
        var hwnd = list.NativeWindow;
        var key = unchecked((int)(long)hwnd);
        var count = Win32.Send(hwnd, Win32.LB_GETCOUNT);
        if (count is not { } total || total < 0) return;
        var chosen = Win32.Send(hwnd, Win32.LB_GETCURSEL) ?? -1;
        Win32.GetClientRect(hwnd, out var client);
        var scale = Capture.Scale(hwnd);
        for (var i = 0; i < Math.Min((int)total, 1000); i++)
        {
            var text = Win32.SendGetText(hwnd, Win32.LB_GETTEXTLEN, Win32.LB_GETTEXT, i, true) ?? "";
            // Rectangle reel de la ligne (LB_GETITEMRECT, ecran) et visibilite : une ligne hors de la partie visible (ou une
            // liste masquee) reste « offscreen », comme pour UIA (relecture de Codex).
            double[] bounds = [];
            var visible = false;
            if (Win32.ItemRect(hwnd, i, out var logical))
            {
                // LB_GETITEMRECT rend des pixels du repere de la LISTE (logiques si elle n'est pas adaptee au DPI : aucun
                // message n'est converti) ; le helper travaille en pixels reels (app.manifest), comme GetClientRect.
                var r = Scaled(logical, scale);
                visible = !r.Intersect(client).Empty;
                // Ligne hors de la partie visible de la LISTE : aucun rectangle, donc refusee comme hors champ (session.mjs,
                // Program.cs), meme si elle tombe encore dans la fenetre (relecture de Codex, 21/10 : ligne sous la liste).
                var origin = new Win32.Point { X = r.Left, Y = r.Top };
                Win32.ClientToScreen(hwnd, ref origin);
                if (visible) bounds = [origin.X, origin.Y, r.Width, r.Height];
            }
            tree.Add(new Node
            {
                Role = "listitem", Name = text, AutomationId = "", Description = "", RuntimeId = [Synthetic, key, SyntheticItem, i], Bounds = bounds,
                Depth = list.Depth + 1, Ancestors = [.. list.Ancestors, list.Index], FrameworkId = list.FrameworkId, ProcessId = list.ProcessId,
                Disabled = list.Disabled, Selected = i == chosen, Offscreen = list.Offscreen || !visible,
            });
        }
    }
    static Win32.Rect Scaled(Win32.Rect r, double scale) => scale == 1.0 ? r : new Win32.Rect
    {
        Left = (int)Math.Round(r.Left * scale), Top = (int)Math.Round(r.Top * scale),
        Right = (int)Math.Round(r.Right * scale), Bottom = (int)Math.Round(r.Bottom * scale),
    };
    public static bool IsSynthetic(int[] runtimeId) => runtimeId is [Synthetic, _, _, _];
    // Noeuds lus par messages sous une liste deroulante classique : son champ (CBS_DROPDOWN), sa liste et ses options.
    // L'etat ouvert (CB_GETDROPPEDSTATE) et la valeur (option choisie) sont portes par la liste deroulante elle-meme.
    public static void SynthesizeCombo(UiTree tree, Node combo)
    {
        var hwnd = combo.NativeWindow;
        var key = unchecked((int)(long)hwnd);
        Node Child(string role, string name, int kind, int rank, int depth, int[] ancestors) => new()
        {
            Role = role, Name = name, AutomationId = "", Description = "", RuntimeId = [Synthetic, key, kind, rank], Bounds = [],
            Depth = depth, Ancestors = ancestors, FrameworkId = combo.FrameworkId, ProcessId = combo.ProcessId, Disabled = combo.Disabled,
        };
        int[] under = [.. combo.Ancestors, combo.Index];
        var edit = Win32.FindWindowExW(hwnd, 0, "Edit", null);
        if (edit != 0)
        {
            var field = Child("edit", combo.Name, SyntheticEdit, 0, combo.Depth + 1, under);
            field.NativeWindow = edit;
            field.Value = Win32.SendGetText(edit, Win32.WM_GETTEXTLENGTH, Win32.WM_GETTEXT, 0, false);
            field.Disabled = combo.Disabled || !Win32.IsWindowEnabled(edit);
            tree.Add(field);
        }
        var count = Win32.Send(hwnd, Win32.CB_GETCOUNT);
        if (count is not { } total || total < 0) return;
        var chosen = Win32.Send(hwnd, Win32.CB_GETCURSEL) ?? -1;
        var list = tree.Add(Child("list", combo.Name, SyntheticList, 0, combo.Depth + 1, under));
        for (var i = 0; i < Math.Min((int)total, 1000); i++)
        {
            var text = Win32.SendGetText(hwnd, Win32.CB_GETLBTEXTLEN, Win32.CB_GETLBTEXT, i, true) ?? "";
            var item = tree.Add(Child("listitem", text, SyntheticItem, i, combo.Depth + 2, [.. under, list.Index]));
            item.Selected = i == chosen;
            if (i == chosen && string.IsNullOrEmpty(combo.Value)) combo.Value = text;
        }
    }

    // Relecture d'identite limitee a la cible et a ses ancetres (vue Controle) : la cible est retrouvee par son identite
    // d'execution (directement sur sa fenetre propre si elle en a une, sinon sous la fenetre), puis sa chaine de parents
    // jusqu'a la racine de la fenetre. Noeuds : racine en 0, cible en dernier. Une cible hors de la fenetre est refusee.
    public UiTree ReadIdentity(nint hwnd, int[] runtimeId, nint hint = 0)
    {
        nint root;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Vt(automation)[10])(automation, hwnd, elementRequest, &root));
        if (root == 0) throw new BackgroundNotApplicableException("No UI Automation element for the window");
        var chain = new List<nint>();
        try
        {
            var found = FromHint(hint, runtimeId, elementRequest);
            if (found == 0)
            {
                var condition = RuntimeIdCondition(runtimeId);
                try { Check(((delegate* unmanaged[Stdcall]<nint, int, nint, nint, nint*, int>)Vt(root)[7])(root, TreeScopeSubtree, condition, elementRequest, &found)); } // FindFirstBuildCache
                finally { Release(condition); }
            }
            // Identite d'execution fournie et introuvable : la cible a ete remplacee ou retiree. Refus, jamais de repli.
            if (found == 0) throw new ActionRefusedException("Target is no longer present (control identity changed); inspect again");
            chain.Add(found);
            var current = found;
            while (!Same(current, root))
            {
                if (chain.Count > MaxDepth + 1) throw new ActionRefusedException("Target ancestry is too deep; inspect again");
                nint parent;
                Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Vt(walker)[9])(walker, current, elementRequest, &parent)); // GetParentElementBuildCache
                if (parent == 0) throw new ActionRefusedException("Target is no longer inside the window; inspect again");
                chain.Add(parent);
                current = parent;
            }
            chain.Reverse();
            var tree = new UiTree();
            try
            {
                for (var i = 0; i < chain.Count; i++)
                {
                    tree.Add(Describe(chain[i], i, [.. Enumerable.Range(0, i)]));
                    chain[i] = 0; // desormais possede par l'arbre
                }
                return tree;
            }
            catch { tree.Dispose(); throw; }
        }
        finally
        {
            foreach (var element in chain) Release(element);
            Release(root);
        }
    }

    // Rang de la cible parmi les enfants de son parent ayant le meme role (onglets sans fenetre propre).
    public int ChildRank(Node parent, Node target)
    {
        nint updated;
        Check(((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(parent.Element)[9])(parent.Element, childrenRequest, &updated)); // BuildUpdatedCache
        var children = new List<nint>();
        try
        {
            children = CachedChildren(updated);
            var rank = 0;
            foreach (var child in children)
            {
                if (Role(CachedInt(child, ControlTypeProperty) ?? 0) != target.Role) continue;
                if ((CachedIntArray(child, RuntimeIdProperty) ?? []).SequenceEqual(target.RuntimeId)) return rank;
                rank++;
            }
            return -1;
        }
        finally
        {
            foreach (var child in children) Release(child);
            Release(updated);
        }
    }

    Node Describe(nint element, int depth, int[] ancestors)
    {
        var password = CachedBool(element, IsPasswordProperty) ?? false;
        var role = Role(CachedInt(element, ControlTypeProperty) ?? 0);
        var hasText = CachedBool(element, IsTextAvailable) == true;
        var hasSelection = CachedBool(element, IsSelectionAvailable) == true;
        // Les mots de passe n'exposent que leur identite, jamais leur valeur.
        string? value = null;
        if (!password && CachedBool(element, IsValueAvailable) == true) value = CachedString(element, ValueValueProperty);
        else if (!password && role == "document" && hasText) value = DocumentText(element);
        var nativeWindow = (nint)(CachedInt(element, NativeWindowHandleProperty) ?? 0);
        var framework = CachedString(element, FrameworkIdProperty) ?? "";
        var classicCombo = role == "combobox" && nativeWindow != 0 && framework is "Win32" or "WinForm" && Win32.BaseClass(nativeWindow) == "combobox";
        // Liste deroulante sans valeur (WPF non editable, liste sans motif Value) : la valeur est l'option choisie, relue
        // sur le conteneur et non sur la presence d'un element de liste dans l'arbre. Liste classique : par messages
        // (SynthesizeCombo), jamais par UIA (un fournisseur peut ne plus repondre liste ouverte).
        if (!password && role == "combobox" && !classicCombo && string.IsNullOrEmpty(value) && hasSelection)
        {
            var chosen = SelectionNames(element);
            if (chosen.Count > 0) value = string.Join(", ", chosen);
        }
        var truncated = value is { Length: > MaxText };
        if (truncated) value = value![..MaxText];
        bool? check = CachedBool(element, IsToggleAvailable) == true
            ? CachedInt(element, ToggleStateProperty) switch { 1 => true, 0 => false, _ => null } : null;
        var node = new Node
        {
            Element = element, Depth = depth, Ancestors = ancestors, Role = role,
            Name = CachedString(element, NameProperty) ?? "", AutomationId = CachedString(element, AutomationIdProperty) ?? "",
            Description = CachedString(element, HelpTextProperty) ?? "", Value = value, ValueTruncated = truncated,
            Disabled = CachedBool(element, IsEnabledProperty) == false, Focused = CachedBool(element, HasKeyboardFocusProperty) == true,
            Password = password, RuntimeId = CachedIntArray(element, RuntimeIdProperty) ?? [],
            Selected = CachedBool(element, IsSelectionItemAvailable) == true ? CachedBool(element, SelectionItemIsSelectedProperty) : null,
            Checked = check, NativeWindow = nativeWindow, FrameworkId = framework, ProcessId = CachedInt(element, ProcessIdProperty) ?? 0,
            HasInvoke = CachedBool(element, IsInvokeAvailable) == true, HasToggle = CachedBool(element, IsToggleAvailable) == true,
            HasText = hasText, Bounds = Bounds(element), Offscreen = CachedBool(element, IsOffscreenProperty) == true,
            AccessKey = CachedString(element, AccessKeyProperty) ?? "", IsDefault = ((CachedInt(element, LegacyIAccessibleStateProperty) ?? 0) & 0x100) != 0,
        };
        if (CachedBool(element, IsExpandCollapseAvailable) == true)
        {
            switch (CachedInt(element, ExpandCollapseStateProperty))
            {
                case 0: node.Actions.Add("Expand"); node.Expanded = false; break;
                case 1: node.Actions.Add("Collapse"); node.Expanded = true; break;
                case 2: node.Expanded = true; break; // partiellement deplie
            }
        }
        return node;
    }
    double[] Bounds(nint element)
    {
        var v = Cached(element, BoundingRectangleProperty);
        try
        {
            if (v.Vt != (VT_ARRAY | VT_R8) || v.Pointer == 0) return [];
            var values = ReadArray<double>(v.Pointer);
            return values.Length == 4 && values[2] > 0 && values[3] > 0 ? values : [];
        }
        finally { VariantClear(ref v); }
    }
    static T[] ReadArray<T>(nint array) where T : unmanaged
    {
        Check(SafeArrayGetLBound(array, 1, out var low));
        Check(SafeArrayGetUBound(array, 1, out var high));
        var count = Math.Max(0, high - low + 1);
        var result = new T[count];
        Check(SafeArrayAccessData(array, out var data));
        try { new ReadOnlySpan<T>((void*)data, count).CopyTo(result); }
        finally { SafeArrayUnaccessData(array); }
        return result;
    }
    static Variant Cached(nint element, int property)
    {
        Variant value;
        Check(((delegate* unmanaged[Stdcall]<nint, int, Variant*, int>)Vt(element)[12])(element, property, &value)); // GetCachedPropertyValue
        return value;
    }
    static string? CachedString(nint element, int property)
    {
        var v = Cached(element, property);
        try { return v.Vt == VT_BSTR ? (v.Pointer == 0 ? "" : Marshal.PtrToStringBSTR(v.Pointer)) : null; }
        finally { VariantClear(ref v); }
    }
    static int? CachedInt(nint element, int property)
    {
        var v = Cached(element, property);
        try { return v.Vt == VT_I4 ? v.Int : null; }
        finally { VariantClear(ref v); }
    }
    static bool? CachedBool(nint element, int property)
    {
        var v = Cached(element, property);
        try { return v.Vt == VT_BOOL ? v.Bool != 0 : null; }
        finally { VariantClear(ref v); }
    }
    static int[]? CachedIntArray(nint element, int property)
    {
        var v = Cached(element, property);
        try { return v.Vt == (VT_ARRAY | VT_I4) && v.Pointer != 0 ? ReadArray<int>(v.Pointer) : null; }
        finally { VariantClear(ref v); }
    }
    static string CurrentName(nint element)
    {
        nint bstr;
        if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(element)[23])(element, &bstr) < 0 || bstr == 0) return ""; // get_CurrentName
        try { return Marshal.PtrToStringBSTR(bstr); } finally { Marshal.FreeBSTR(bstr); }
    }
    // Noms des elements choisis d'un conteneur de selection (motif Selection courant).
    static List<string> SelectionNames(nint element)
    {
        var names = new List<string>();
        var pattern = Pattern(element, SelectionPatternId);
        if (pattern == 0) return names;
        try
        {
            nint array;
            if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(pattern)[3])(pattern, &array) < 0 || array == 0) return names; // GetCurrentSelection
            try
            {
                int length;
                Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(array)[3])(array, &length));
                for (var i = 0; i < length && i < 64; i++)
                {
                    nint item;
                    if (((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Vt(array)[4])(array, i, &item) < 0 || item == 0) continue;
                    try { names.Add(CurrentName(item)); } finally { Release(item); }
                }
            }
            finally { Release(array); }
        }
        finally { Release(pattern); }
        return names;
    }
    // Texte d'un document (motif Text courant), borne a MaxText + 1 caracteres pour signaler la troncature.
    public static string? DocumentText(nint element)
    {
        var pattern = Pattern(element, TextPatternId);
        if (pattern == 0) return null;
        try
        {
            nint range;
            if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(pattern)[7])(pattern, &range) < 0 || range == 0) return null; // get_DocumentRange
            try
            {
                nint bstr;
                if (((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Vt(range)[12])(range, MaxText + 1, &bstr) < 0) return null; // GetText
                if (bstr == 0) return "";
                try { return Marshal.PtrToStringBSTR(bstr); } finally { Marshal.FreeBSTR(bstr); }
            }
            finally { Release(range); }
        }
        finally { Release(pattern); }
    }

    public static string Role(int controlType) => controlType switch
    {
        50000 => "button", 50001 => "calendar", 50002 => "checkbox", 50003 => "combobox", 50004 => "edit", 50005 => "link",
        50006 => "image", 50007 => "listitem", 50008 => "list", 50009 => "menu", 50010 => "menubar", 50011 => "menuitem",
        50012 => "progressbar", 50013 => "radio", 50014 => "scrollbar", 50015 => "slider", 50016 => "spinner", 50017 => "statusbar",
        50018 => "tab", 50019 => "tab", 50020 => "text", 50021 => "toolbar", 50022 => "tooltip", 50023 => "tree", 50024 => "treeitem",
        50025 => "custom", 50026 => "group", 50027 => "thumb", 50028 => "datagrid", 50029 => "dataitem", 50030 => "document",
        50031 => "splitbutton", 50032 => "window", 50033 => "pane", 50034 => "header", 50035 => "headeritem", 50036 => "table",
        50037 => "titlebar", 50038 => "separator", 50039 => "semanticzoom", 50040 => "appbar",
        _ => "unknown",
    };

    // ---- Motifs ------------------------------------------------------------------------------------------------------
    // Motif courant (GetCurrentPatternAs) ou 0 s'il n'est pas pris en charge. A liberer.
    public static nint Pattern(nint element, int patternId)
    {
        var iid = patternId switch
        {
            InvokePatternId => IidInvoke, TogglePatternId => IidToggle, ValuePatternId => IidValue,
            SelectionItemPatternId => IidSelectionItem, ExpandCollapsePatternId => IidExpandCollapse,
            SelectionPatternId => IidSelection, TextPatternId => IidText, ScrollPatternId => IidScroll,
            ScrollItemPatternId => IidScrollItem, LegacyIAccessiblePatternId => IidLegacy,
            _ => throw new ArgumentOutOfRangeException(nameof(patternId)),
        };
        nint pattern;
        var hr = ((delegate* unmanaged[Stdcall]<nint, int, Guid*, nint*, int>)Vt(element)[14])(element, patternId, &iid, &pattern);
        return hr < 0 ? 0 : pattern;
    }
    // Premiere methode propre a chaque interface de motif : Invoke, Toggle, SetValue, Select, Expand (emplacement 3).
    public static void CallSlot(nint pattern, int slot) => Check(((delegate* unmanaged[Stdcall]<nint, int>)Vt(pattern)[slot])(pattern));
    public static double ReadDouble(nint pattern, int slot)
    {
        double value;
        Check(((delegate* unmanaged[Stdcall]<nint, double*, int>)Vt(pattern)[slot])(pattern, &value));
        return value;
    }
    // IUIAutomationScrollPattern::Scroll(horizontalAmount, verticalAmount) : ScrollAmount 1 = petit retrait, 2 = rien,
    // 4 = petite avance.
    public static void Scroll(nint pattern, int horizontal, int vertical) =>
        Check(((delegate* unmanaged[Stdcall]<nint, int, int, int>)Vt(pattern)[3])(pattern, horizontal, vertical));
    public static int ProcessIdOf(nint element)
    {
        int pid;
        return ((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(element)[20])(element, &pid) < 0 ? 0 : pid; // get_CurrentProcessId
    }
    public static int ReadInt(nint pattern, int slot)
    {
        int value;
        Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(pattern)[slot])(pattern, &value));
        return value;
    }
    public static void SetValue(nint valuePattern, string text)
    {
        var bstr = Marshal.StringToBSTR(text);
        try { Check(((delegate* unmanaged[Stdcall]<nint, nint, int>)Vt(valuePattern)[3])(valuePattern, bstr)); }
        finally { Marshal.FreeBSTR(bstr); }
    }
    public static string? Value(nint valuePattern)
    {
        nint bstr;
        if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(valuePattern)[4])(valuePattern, &bstr) < 0) return null;
        if (bstr == 0) return "";
        try { return Marshal.PtrToStringBSTR(bstr); } finally { Marshal.FreeBSTR(bstr); }
    }
    // Focus explicite (SetFocus) et relecture du focus clavier courant.
    public static void SetFocus(nint element) => Check(((delegate* unmanaged[Stdcall]<nint, int>)Vt(element)[3])(element));
    public static bool HasKeyboardFocus(nint element)
    {
        int focused;
        return ((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(element)[26])(element, &focused) >= 0 && focused != 0; // get_CurrentHasKeyboardFocus
    }
    public int ControlTypeOfWindow(nint hwnd)
    {
        var element = ElementFromHandle(hwnd);
        try { return ControlType(element); } finally { Release(element); }
    }
    public static int ControlType(nint element)
    {
        int type;
        return ((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(element)[21])(element, &type) >= 0 ? type : 0; // get_CurrentControlType
    }

    // Conteneur defilable sur l'axe sous un point, cherche dans le SOUS-ARBRE UI Automation de la fenetre `hwnd` (jamais
    // un test global au point : une autre fenetre, meme du meme processus, peut recouvrir la cible ; relecture de Codex,
    // 21/10) : candidats visibles, du processus de la fenetre, dont le rectangle contient le point ; choix par
    // ScrollChoice (plus petite aire, le plus profond a aire egale, ambigu = refus). (element, motif) a liberer, ou
    // (0, 0) sans candidat. Aucune fuite COM sur exception. Rectangles en pixels du contexte DPI du fil appelant.
    public (nint Element, nint Pattern) ScrollContainerAt(nint hwnd, int x, int y, bool vertical)
    {
        nint array;
        var root = ElementFromHandle(hwnd);
        try
        {
            var condition = Condition(30034 /* UIA_IsScrollPatternAvailablePropertyId */, new Variant { Vt = VT_BOOL, Bool = -1 });
            try { Check(((delegate* unmanaged[Stdcall]<nint, int, nint, nint*, int>)Vt(root)[6])(root, TreeScopeSubtree, condition, &array)); } // FindAll
            finally { Release(condition); }
        }
        finally { Release(root); }
        if (array == 0) return (0, 0);
        var pid = (int)Win32.ProcessOf(hwnd);
        var candidates = new List<(nint Element, nint Pattern, long Area)>();
        var chosen = -1;
        try
        {
            int length;
            Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(array)[3])(array, &length));
            ScrollChoice.CheckCount(length);
            for (var i = 0; i < length; i++)
            {
                nint element;
                if (((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Vt(array)[4])(array, i, &element) < 0 || element == 0) continue;
                nint pattern = 0;
                var keep = false;
                try
                {
                    Win32.Rect r;
                    int offscreen;
                    if (ProcessIdOf(element) != pid) continue;
                    if (((delegate* unmanaged[Stdcall]<nint, Win32.Rect*, int>)Vt(element)[43])(element, &r) < 0) continue; // get_CurrentBoundingRectangle
                    if (x < r.Left || y < r.Top || x >= r.Right || y >= r.Bottom) continue;
                    if (((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(element)[38])(element, &offscreen) < 0 || offscreen != 0) continue; // get_CurrentIsOffscreen
                    pattern = Pattern(element, ScrollPatternId);
                    if (pattern == 0 || ReadInt(pattern, vertical ? 10 : 9) == 0) continue; // get_CurrentVertically/HorizontallyScrollable
                    candidates.Add((element, pattern, (long)r.Width * r.Height));
                    keep = true;
                }
                finally { if (!keep) { Release(pattern); Release(element); } }
            }
            chosen = ScrollChoice.Pick(candidates.Select(c => c.Area).ToList(), (a, b) => IsDescendant(candidates[a].Element, candidates[b].Element));
            return chosen < 0 ? (0, 0) : (candidates[chosen].Element, candidates[chosen].Pattern);
        }
        finally
        {
            Release(array);
            for (var i = 0; i < candidates.Count; i++) if (i != chosen) { Release(candidates[i].Pattern); Release(candidates[i].Element); }
        }
    }

    // `child` est-il un descendant strict de `ancestor` (vue Controle, 64 niveaux au plus) ?
    bool IsDescendant(nint child, nint ancestor)
    {
        var current = child;
        var owned = false;
        try
        {
            for (var depth = 0; depth < 64; depth++)
            {
                nint parent = 0;
                if (((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(walker)[3])(walker, current, &parent) < 0 || parent == 0) return false; // GetParentElement
                if (owned) Release(current);
                current = parent;
                owned = true;
                if (Same(current, ancestor)) return true;
            }
            return false;
        }
        finally { if (owned) Release(current); }
    }

    // Element de menu DIRECTEMENT sous `scope` (MenuSearch : sans franchir un autre element de menu, nom et identifiant
    // d'automatisation, lecture complete ou refus), par la vue Controle. 0 si absent ; a liberer.
    public nint MenuChild(nint scope, string name, string? automationId)
    {
        var held = new List<nint>();
        nint kept = 0;
        try
        {
            IReadOnlyList<nint> Children(nint parent)
            {
                var list = new List<nint>();
                nint child;
                if (((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(walker)[4])(walker, parent, &child) < 0) // GetFirstChildElement
                    throw new BackgroundNotApplicableException("Menu could not be read completely: nothing was sent");
                while (child != 0)
                {
                    held.Add(child);
                    list.Add(child);
                    if (held.Count > MenuSearch.Max + 1) throw new BackgroundNotApplicableException("Menu too large to be read completely: nothing was sent");
                    nint next;
                    if (((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)Vt(walker)[6])(walker, child, &next) < 0) // GetNextSiblingElement
                        throw new BackgroundNotApplicableException("Menu could not be read completely: nothing was sent");
                    child = next;
                }
                return list;
            }
            var (found, item) = MenuSearch.Find(scope, Children, e => ControlType(e) == 50011 /* MenuItem */, CurrentName, CurrentAutomationId, name, automationId);
            if (found) kept = item;
            return kept;
        }
        finally { foreach (var element in held) if (element != kept) Release(element); }
    }
    static string CurrentAutomationId(nint element)
    {
        nint bstr;
        if (((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(element)[29])(element, &bstr) < 0 || bstr == 0) return ""; // get_CurrentAutomationId
        try { return Marshal.PtrToStringBSTR(bstr); } finally { Marshal.FreeBSTR(bstr); }
    }
    public nint WindowElement(nint hwnd) => ElementFromHandle(hwnd);

    // ---- Chromium sans activation (recette commune : NexusClaude act_chromium, NexusAGY _chromium_simulated_typing) ----
    // Focus DOM par l'action MSAA accSelect(SELFLAG_TAKEFOCUS) : contrairement a UIA SetFocus, n'active pas la fenetre.
    public static void TakeFocus(nint element)
    {
        var pattern = Pattern(element, LegacyIAccessiblePatternId);
        if (pattern == 0) throw new BackgroundNotApplicableException("No MSAA action to focus without activation");
        try { Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Vt(pattern)[3])(pattern, 1 /* SELFLAG_TAKEFOCUS */)); } // Select
        finally { Release(pattern); }
    }

    // Caret en fin de texte (plage vide a la fin du document de l'element, selectionnee) : la frappe s'ajoute.
    public static void CaretToEnd(nint element)
    {
        var pattern = Pattern(element, TextPatternId);
        if (pattern == 0) throw new BackgroundNotApplicableException("No text pattern to place the caret: nothing was typed");
        nint range = 0;
        try
        {
            Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vt(pattern)[7])(pattern, &range)); // get_DocumentRange
            Check(((delegate* unmanaged[Stdcall]<nint, int, nint, int, int>)Vt(range)[15])(range, 0 /* Start */, range, 1 /* End */)); // MoveEndpointByRange
            Check(((delegate* unmanaged[Stdcall]<nint, int>)Vt(range)[16])(range)); // Select
        }
        finally { Release(range); Release(pattern); }
    }

    // Chromium recouvert retarde la publication UIA de ses changements : un ScrollIntoView sur le document racine (sans
    // effet visible) la declenche (recette d'Antigravity, flush_chromium).
    public void Flush(nint hwnd)
    {
        var root = ElementFromHandle(hwnd);
        nint document = 0, pattern = 0;
        try
        {
            var condition = Condition(ControlTypeProperty, new Variant { Vt = VT_I4, Int = 50030 /* Document */ });
            try { document = FindFirst(root, condition); }
            finally { Release(condition); }
            if (document == 0) return;
            pattern = Pattern(document, ScrollItemPatternId);
            if (pattern != 0) ((delegate* unmanaged[Stdcall]<nint, int>)Vt(pattern)[3])(pattern); // ScrollIntoView
        }
        finally { Release(pattern); Release(document); Release(root); }
    }

    // Elements selectionnables (motif SelectionItem) sous un conteneur, avec leur nom, en un aller-retour. A liberer.
    public List<(nint Element, string Name)> SelectableItems(nint container)
    {
        var condition = Condition(IsSelectionItemAvailable, new Variant { Vt = VT_BOOL, Bool = -1 });
        nint array;
        try { Check(((delegate* unmanaged[Stdcall]<nint, int, nint, nint, nint*, int>)Vt(container)[8])(container, 4 /* Descendants */, condition, elementRequest, &array)); } // FindAllBuildCache
        finally { Release(condition); }
        var items = new List<(nint, string)>();
        if (array == 0) return items;
        try
        {
            int length;
            Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Vt(array)[3])(array, &length));
            for (var i = 0; i < length && i < 5000; i++)
            {
                nint item;
                Check(((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Vt(array)[4])(array, i, &item));
                if (item != 0) items.Add((item, CachedString(item, NameProperty) ?? ""));
            }
        }
        finally { Release(array); }
        return items;
    }
}

// Noeud de l'arbre lu : proprietes en cache, plus l'element COM (a liberer avec l'arbre) pour les lectures courantes.
sealed class Node
{
    public nint Element;
    public int Index, Depth, ProcessId;
    public required string Role, Name, AutomationId, Description;
    public string FrameworkId = "";
    public string? Value;
    // Offscreen : UIA IsOffscreen (defile hors de la partie visible, fenetre reduite...), signale a la session.
    public bool Disabled, Focused, Password, ValueTruncated, HasInvoke, HasToggle, HasText, Offscreen, IsDefault;
    public string AccessKey = "";
    public bool? Selected, Checked, Expanded;
    public nint NativeWindow;
    public required int[] RuntimeId, Ancestors;
    public required double[] Bounds;
    public List<string> Actions = new();
}

sealed class UiTree : IDisposable
{
    public readonly List<Node> Nodes = new();
    // Parents ajoutes avant leurs enfants. Un element sans FrameworkId (enfant MSAA d'une liste Win32 servi par le proxy
    // natif) herite de celui de son parent : la famille d'interface decide de la technique (jamais SelectionItem.Select
    // sur une liste Win32/WinForms, la selection y changerait sans prevenir l'application).
    public Node Add(Node node)
    {
        node.Index = Nodes.Count;
        if (node.FrameworkId.Length == 0 && node.Ancestors.Length > 0) node.FrameworkId = Nodes[node.Ancestors[^1]].FrameworkId;
        Nodes.Add(node);
        return node;
    }
    public void Dispose()
    {
        foreach (var node in Nodes) { ComUia.Release(node.Element); node.Element = 0; }
        Nodes.Clear();
    }
}
