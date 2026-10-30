using System.Runtime.InteropServices;
namespace NavoDesktop;

internal sealed class Safety : IDisposable
{
    long generation;
    readonly object inputGate = new();
    volatile bool watching;
    volatile bool stopped = true;
    readonly InputMonitor monitor;
    public long Generation => Interlocked.Read(ref generation);
    public Safety()
    {
        monitor = new InputMonitor(this);
    }
    public void Check(long token)
    {
        if (token != Generation)
            throw new InvalidOperationException("用户已停止桌面操作，已取消排队命令");
    }
    public void Require(long token)
    {
        Check(token);
        if (stopped || !watching)
            throw new InvalidOperationException("用户输入监听未启用或用户已停止桌面操作");
    }
    public void Arm(long token, bool fake = false)
    {
        Check(token);
        if (!fake)
            monitor.Start();
        Check(token);
        stopped = false;
        watching = true;
        if (token != Generation)
        {
            stopped = true;
            watching = false;
            Check(token);
        }
    }
    public void Stop()
    {
        lock (inputGate)
        {
            stopped = true;
            watching = false;
            Interlocked.Increment(ref generation);
        }
    }
    public void Send(long token, Native.INPUT[] events, nint expectedWindow, Native.POINT? location = null)
    {
        Require(token);
        // Reinstall before every batch: Windows has no supported query for a hook
        // silently removed after a callback timeout. This introduces no probe input.
        try
        {
            monitor.Start(false);
        }
        catch { Stop(); throw; }
        lock (inputGate)
        {
            Require(token);
            Native.SafeDesktop();
            if (Native.GetForegroundWindow() != expectedWindow)
                throw new InvalidOperationException("输入前目标窗口已改变");
            if (location is Native.POINT point && Native.GetAncestor(Native.WindowFromPoint(point), 2) != expectedWindow)
                throw new InvalidOperationException("坐标已被其他窗口遮挡");
            Native.Send(events);
        }
    }
    public void UserInput(string reason)
    {
        if (!watching || stopped)
            return;
        // The low-level hook must never wait for inputGate or stdout: SendInput can
        // be waiting for this callback, and Windows removes slow hooks silently.
        stopped = true;
        watching = false;
        Interlocked.Increment(ref generation);
        ThreadPool.QueueUserWorkItem(_ => Program.Emit(new { @event = "user_input", reason }));
    }
    public void Dispose()
    {
        Stop();
        monitor.Dispose();
    }
}
internal sealed class InputMonitor : IDisposable
{
    readonly Safety safety;
    Thread? thread;
    uint threadId;
    nint keyboard, mouse;
    volatile bool installSucceeded;
    readonly Native.HookProc keyCallback, mouseCallback;
    Native.POINT anchor;
    readonly ManualResetEventSlim ready = new();
    public InputMonitor(Safety s)
    {
        safety = s;
        keyCallback = (code, w, l) =>
        {
            if (code >= 0 && (w == 0x100 || w == 0x104))
            {
                var data = Marshal.PtrToStructure<Native.KBDLLHOOKSTRUCT>(l);
                if (data.dwExtraInfo != Native.Marker && data.vkCode == 27)
                    safety.UserInput("escape");
            }
            return Native.CallNextHookEx(0, code, w, l);
        };
        mouseCallback = (code, w, l) =>
        {
            if (code >= 0 && w == 0x200)
            {
                var data = Marshal.PtrToStructure<Native.MSLLHOOKSTRUCT>(l);
                if (data.dwExtraInfo == Native.Marker)
                    anchor = data.pt;
                else if (Math.Sqrt(Math.Pow(data.pt.x - anchor.x, 2) + Math.Pow(data.pt.y - anchor.y, 2)) > 20)
                {
                    anchor = data.pt;
                    safety.UserInput("mouse");
                }
            }
            return Native.CallNextHookEx(0, code, w, l);
        };
    }
    public void Start(bool resetAnchor = true)
    {
        if (resetAnchor)
            Native.GetCursorPos(out anchor);
        if (thread == null)
        {
            thread = new Thread(() =>
            {
                try
                {
                    threadId = Native.GetCurrentThreadId();
                    Native.PeekMessage(out _, 0, 0, 0, 0); // create queue before publishing ready
                    void Install()
                    {
                        installSucceeded = false;
                        var nextKeyboard = Native.SetWindowsHookEx(13, keyCallback, Native.GetModuleHandle(null), 0);
                        var nextMouse = Native.SetWindowsHookEx(14, mouseCallback, Native.GetModuleHandle(null), 0);
                        if (nextKeyboard != 0 && nextMouse != 0)
                        {
                            var previousKeyboard = keyboard;
                            var previousMouse = mouse;
                            keyboard = nextKeyboard;
                            mouse = nextMouse;
                            installSucceeded = true;
                            if (previousKeyboard != 0)
                                Native.UnhookWindowsHookEx(previousKeyboard);
                            if (previousMouse != 0)
                                Native.UnhookWindowsHookEx(previousMouse);
                        }
                        else
                        {
                            if (nextKeyboard != 0)
                                Native.UnhookWindowsHookEx(nextKeyboard);
                            if (nextMouse != 0)
                                Native.UnhookWindowsHookEx(nextMouse);
                        }
                        ready.Set();
                    }
                    Install();
                    if (keyboard != 0 && mouse != 0)
                    while (Native.GetMessage(out var msg, 0, 0, 0) > 0)
                    {
                        if (msg.message == 0x8001)
                            Install();
                        else
                        {
                            Native.TranslateMessage(ref msg);
                            Native.DispatchMessage(ref msg);
                        }
                    }
                }
                catch { /* monitoring failures stop input below */ }
                finally
                {
                    if (keyboard != 0)
                        Native.UnhookWindowsHookEx(keyboard);
                    if (mouse != 0)
                        Native.UnhookWindowsHookEx(mouse);
                    keyboard = 0;
                    mouse = 0;
                    ready.Set();
                    safety.UserInput("monitor_unavailable");
                }
            })
            {
                IsBackground = true,
                Name = "Navo physical input hooks"
            };
            thread.Start();
        }
        else
        {
            ready.Reset();
            installSucceeded = false;
            if (!Native.PostThreadMessage(threadId, 0x8001, 0, 0))
                throw new InvalidOperationException("无法恢复用户输入监听");
        }
        if (!ready.Wait(3000) || !installSucceeded || keyboard == 0 || mouse == 0 || !thread.IsAlive)
            throw new InvalidOperationException("无法监听用户输入，已拒绝桌面操作");
    }
    public void Dispose()
    {
        if (threadId != 0)
            Native.PostThreadMessage(threadId, 0x12, 0, 0);
        thread?.Join(500);
    }
}
