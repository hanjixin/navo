using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
namespace NavoDesktop;

internal static class Native
{
    internal sealed record WindowBounds(double x, double y, double width, double height);
    internal sealed record WindowIdentity(string id, int pid, WindowBounds bounds);
    internal static WindowIdentity DescribeWindow(nint handle)
    {
        if (handle == 0 || !GetWindowRect(handle, out var r))
            throw new InvalidOperationException("无法确定目标窗口");
        GetWindowThreadProcessId(handle, out uint pid);
        return new(handle.ToString(), (int)pid, new(r.left, r.top, r.right - r.left, r.bottom - r.top));
    }
    internal static bool SameWindow(WindowIdentity expected, WindowIdentity actual) =>
        expected == actual && expected.id.Length > 0 && expected.pid > 0 &&
        double.IsFinite(expected.bounds.x) && double.IsFinite(expected.bounds.y) &&
        double.IsFinite(expected.bounds.width) && double.IsFinite(expected.bounds.height) &&
        expected.bounds.width > 0 && expected.bounds.height > 0;
    internal static void ValidateWindow(WindowIdentity expected) {
        if (!SameWindow(expected, DescribeWindow(GetForegroundWindow())))
            throw new InvalidOperationException("目标窗口或位置已改变，请重新获取快照");
    }
    public static readonly nuint Marker = 0x4e41564f;
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x, y;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left, top, right, bottom;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public nint hwnd; public uint message; public nuint wParam; public nint lParam; public uint time; public POINT pt; public uint lPrivate;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode, scanCode, flags, time; public nuint dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt; public uint mouseData, flags, time; public nuint dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type; public UNION data;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct UNION
    {
        [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx, dy; public uint mouseData, flags, time; public nuint extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort vk, scan; public uint flags, time; public nuint extra;
    }
    public delegate nint HookProc(int code, nint w, nint l);
    public delegate bool EnumProc(nint hwnd, nint param);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, nint p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint h);
    [DllImport("user32.dll")] public static extern bool IsWindow(nint h);
    [DllImport("user32.dll")] public static extern bool IsIconic(nint h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(nint h, StringBuilder s, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint h, out uint pid);
    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(nint h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(nint h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(nint h, out RECT r);
    [DllImport("user32.dll")] public static extern nint WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern nint GetAncestor(nint h, uint flag);
    [DllImport("user32.dll")] public static extern bool PrintWindow(nint h, nint dc, uint flags);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern nint SetWindowsHookEx(int id, HookProc cb, nint module, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] public static extern nint CallNextHookEx(nint hook, int code, nint w, nint l);
    [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, nint h, uint min, uint max, uint flags);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, nint h, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] public static extern nint DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint id, uint msg, nuint w, nint l);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern nint GetModuleHandle(string? name);
    [DllImport("user32.dll")] static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(nint h, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(nint h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(nint p, uint access, out nint token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(nint token, int type, nint data, int size, out int length);
    [DllImport("advapi32.dll")] static extern nint GetSidSubAuthority(nint sid, uint index);
    [DllImport("advapi32.dll")] static extern nint GetSidSubAuthorityCount(nint sid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint h);
    public static void SafeDesktop()
    {
        var desk = OpenInputDesktop(0, false, 1);
        if (desk == 0)
            throw new InvalidOperationException("拒绝操作登录或安全桌面");
        try
        {
            var name = new StringBuilder(256);
            if (!GetUserObjectInformation(desk, 2, name, 512, out _) || !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("拒绝操作登录或安全桌面");
        }
        finally { CloseDesktop(desk); }
    }
    public static int Integrity(Process process)
    {
        if (!OpenProcessToken(process.Handle, 8, out var token))
            throw new InvalidOperationException("无法确认目标权限级别");
        try
        {
            GetTokenInformation(token, 25, 0, 0, out int length);
            var data = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, 25, data, length, out _))
                    throw new InvalidOperationException("无法确认目标权限级别");
                var sid = Marshal.ReadIntPtr(data);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        finally { CloseHandle(token); }
    }
    public static INPUT Key(ushort key, bool up = false, bool unicode = false) => new() { type = 1, data = new UNION { key = new KEYBDINPUT { vk = unicode ? (ushort)0 : key, scan = unicode ? key : (ushort)0, flags = (up ? 2u : 0u) | (unicode ? 4u : 0u) | (!unicode && (key is >= 33 and <= 46 or 0x5b) ? 1u : 0u), extra = Marker } } };
    public static INPUT Mouse(uint flags, int x = 0, int y = 0, int data = 0) => new() { type = 0, data = new UNION { mouse = new MOUSEINPUT { dx = x, dy = y, flags = flags, mouseData = unchecked((uint)data), extra = Marker } } };
    public static void Send(INPUT[] events)
    {
        foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5b, 0x5c })
        {
            if ((GetAsyncKeyState(key) & 0x8000) != 0)
                throw new InvalidOperationException("用户正在按住修饰键，请松开后重试");
        }
        if (SendInput((uint)events.Length, events, Marshal.SizeOf<INPUT>()) != events.Length)
        {
            // A partial batch must not leave a key or mouse button down.
            var ups = events.Where(e => e.type == 1).Select(e => Key(e.data.key.vk == 0 ? e.data.key.scan : e.data.key.vk, true, (e.data.key.flags & 4) != 0)).ToList();
            ups.Add(Mouse(4));
            ups.Add(Mouse(16));
            SendInput((uint)ups.Count, ups.ToArray(), Marshal.SizeOf<INPUT>());
            throw new InvalidOperationException("输入被Windows拒绝（权限级别或安全桌面）");
        }
    }
}
