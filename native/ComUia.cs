using System.Runtime.InteropServices;

// Client COM UI Automation (CUIAutomation8 / IUIAutomation2) pour les motifs d'arriere-plan.
// Le client gere de System.Windows.Automation n'expose pas AutoSetFocus : par defaut, UIA donne le focus a l'element
// avant un motif (Invoke, Toggle...), ce qui active la fenetre cible. Ici AutoSetFocus = FALSE, relu apres reglage.
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
    public const int InvokePatternId = 10000, ValuePatternId = 10002, ExpandCollapsePatternId = 10005, SelectionItemPatternId = 10010, TogglePatternId = 10015;
    const int RuntimeIdPropertyId = 30000, NamePropertyId = 30005;
    const int TreeScopeSubtree = 7;
    const ushort VT_BSTR = 8, VT_I4 = 3, VT_ARRAY = 0x2000;

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct Variant { [FieldOffset(0)] public ushort Vt; [FieldOffset(8)] public nint Pointer; }

    [DllImport("ole32.dll")] static extern int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint instance);
    [DllImport("oleaut32.dll")] static extern nint SafeArrayCreateVector(ushort vt, int lowerBound, uint count);
    [DllImport("oleaut32.dll")] static extern int SafeArrayAccessData(nint array, out nint data);
    [DllImport("oleaut32.dll")] static extern int SafeArrayUnaccessData(nint array);
    [DllImport("oleaut32.dll")] static extern int VariantClear(ref Variant value);

    static ComUia? shared;
    readonly nint automation;
    public static ComUia Shared => shared ??= new ComUia();

    ComUia()
    {
        // Une VARIANT de 24 octets suppose un processus 64 bits (x64, ARM64).
        if (!Environment.Is64BitProcess) throw new BackgroundNotApplicableException("COM UI Automation background patterns require a 64-bit helper");
        Check(CoCreateInstance(ClsidCUIAutomation8, 0, 1 /* CLSCTX_INPROC_SERVER */, IidIUIAutomation2, out automation));
        var vtable = *(nint**)automation;
        Check(((delegate* unmanaged[Stdcall]<nint, int, int>)vtable[59])(automation, 0));            // put_AutoSetFocus(FALSE)
        Check(((delegate* unmanaged[Stdcall]<nint, uint, int>)vtable[61])(automation, 2000));         // put_ConnectionTimeout
        Check(((delegate* unmanaged[Stdcall]<nint, uint, int>)vtable[63])(automation, 5000));         // put_TransactionTimeout
        int autoSetFocus;
        Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)vtable[58])(automation, &autoSetFocus)); // get_AutoSetFocus
        if (autoSetFocus != 0) throw new BackgroundNotApplicableException("UI Automation refused AutoSetFocus = FALSE");
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
    static nint FindFirst(nint scopeRoot, nint condition)
    {
        nint found;
        Check(((delegate* unmanaged[Stdcall]<nint, int, nint, nint*, int>)Vt(scopeRoot)[5])(scopeRoot, TreeScopeSubtree, condition, &found));
        return found;
    }

    // Element courant d'identite d'execution donnee, cherche sous la fenetre. Le resultat est a liberer (Release).
    public nint FindByRuntimeId(nint window, int[] runtimeId)
    {
        var array = SafeArrayCreateVector(VT_I4, 0, (uint)runtimeId.Length);
        if (array == 0) throw new OutOfMemoryException();
        Check(SafeArrayAccessData(array, out var data));
        Marshal.Copy(runtimeId, 0, data, runtimeId.Length);
        Check(SafeArrayUnaccessData(array));
        return FindUnder(window, RuntimeIdPropertyId, new Variant { Vt = VT_ARRAY | VT_I4, Pointer = array });
    }
    public nint FindByName(nint scopeRoot, string name)
    {
        var condition = Condition(NamePropertyId, new Variant { Vt = VT_BSTR, Pointer = Marshal.StringToBSTR(name) });
        try { return FindFirst(scopeRoot, condition); }
        finally { Release(condition); }
    }
    nint FindUnder(nint window, int property, Variant value)
    {
        var root = ElementFromHandle(window);
        try
        {
            var condition = Condition(property, value);
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

    // Motif courant (GetCurrentPatternAs) ou 0 s'il n'est pas pris en charge. A liberer.
    public static nint Pattern(nint element, int patternId)
    {
        var iid = patternId switch
        {
            InvokePatternId => IidInvoke, TogglePatternId => IidToggle, ValuePatternId => IidValue,
            SelectionItemPatternId => IidSelectionItem, ExpandCollapsePatternId => IidExpandCollapse,
            _ => throw new ArgumentOutOfRangeException(nameof(patternId)),
        };
        nint pattern;
        var hr = ((delegate* unmanaged[Stdcall]<nint, int, Guid*, nint*, int>)Vt(element)[14])(element, patternId, &iid, &pattern);
        return hr < 0 ? 0 : pattern;
    }
    // Premiere methode propre a chaque interface de motif : Invoke, Toggle, SetValue, Select, Expand (emplacement 3).
    public static void CallSlot(nint pattern, int slot) => Check(((delegate* unmanaged[Stdcall]<nint, int>)Vt(pattern)[slot])(pattern));
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
}
