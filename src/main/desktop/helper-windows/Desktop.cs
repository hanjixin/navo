using System.IO;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using Microsoft.Win32;
using System.Drawing;
using System.Drawing.Imaging;

namespace NavoDesktop;

internal sealed class Desktop(Safety safety)
{
    readonly Dictionary<string, (AutomationElement Element, int Pid, System.Windows.Rect Bounds, nint Window, long Generation)> refs = new();
    int serial;
    static string Identity(Process p) => Path.GetFullPath(p.MainModule!.FileName!).ToLowerInvariant();
    static List<nint> Windows()
    {
        var result = new List<nint>();
        Native.EnumWindows((h, _) => { if (Native.IsWindowVisible(h)) { var s = new StringBuilder(1024); Native.GetWindowText(h, s, s.Capacity); if (s.Length > 0) result.Add(h); } return true; }, 0);
        return result;
    }
    static Process ProcessOf(nint h)
    {
        Native.GetWindowThreadProcessId(h, out uint pid);
        return Process.GetProcessById((int)pid);
    }
    static string DisplayName(Process p)
    {
        try
        {
            var info = FileVersionInfo.GetVersionInfo(p.MainModule!.FileName!);
            if (!string.IsNullOrWhiteSpace(info.FileDescription))
                return info.FileDescription;
            if (!string.IsNullOrWhiteSpace(info.ProductName))
                return info.ProductName;
        }
        catch { }
        return p.ProcessName;
    }
    static object App(nint h)
    {
        using var p = ProcessOf(h);
        var name = new StringBuilder(1024);
        Native.GetWindowText(h, name, name.Capacity);
        return new
        {
            bundleId = Identity(p),
            name = DisplayName(p),
            pid = p.Id,
            windows = new[] { name.ToString() }
        };
    }
    static nint Find(string id)
    {
        var matches = new List<nint>();
        foreach (var h in Windows())
            try
            {
                using var p = ProcessOf(h);
                if (Identity(p) == id.ToLowerInvariant())
                    matches.Add(h);
            }
            catch { }
        var foreground = Native.GetForegroundWindow();
        if (matches.Contains(foreground))
            return foreground;
        foreach (var h in matches)
        {
            using var p = ProcessOf(h);
            if (p.MainWindowHandle != 0 && matches.Contains(p.MainWindowHandle))
                return p.MainWindowHandle;
        }
        if (matches.Count == 1)
            return matches[0];
        throw new InvalidOperationException(matches.Count == 0 ? "应用没有可操作窗口" : "应用有多个窗口，请先聚焦目标窗口");
    }
    static object Rect(System.Windows.Rect r) => new { x = double.IsFinite(r.X) ? r.X : 0, y = double.IsFinite(r.Y) ? r.Y : 0, width = double.IsFinite(r.Width) ? r.Width : 0, height = double.IsFinite(r.Height) ? r.Height : 0 };
    void Guard(string id, long generation, bool input = false)
    {
        if (input)
            safety.Require(generation);
        else
            safety.Check(generation);
        Native.SafeDesktop();
        using var p = ProcessOf(Native.GetForegroundWindow());
        if (Identity(p) != id)
            throw new InvalidOperationException("前台应用已改变，请重新获取快照");
        using var self = Process.GetCurrentProcess();
        if (Native.Integrity(p) > Native.Integrity(self))
            throw new InvalidOperationException("拒绝操作权限高于Navo的应用");
    }
    static void SafeElement(AutomationElement element)
    {
        for (int i = 0; i < 80 && element != null; i++)
        {
            if (element.Current.IsPassword)
                throw new InvalidOperationException("不能操作密码输入框");
            element = TreeWalker.ControlViewWalker.GetParent(element);
        }
    }
    AutomationElement? Node(JsonElement a, string id)
    {
        string key = a.Text("ref");
        if (key.Length == 0)
            return null;
        if (!refs.TryGetValue(key, out var saved))
            throw new InvalidOperationException("元素引用已失效，请重新获取快照");
        using var process = ProcessOf(Native.GetForegroundWindow());
        if (saved.Generation != safety.Generation || saved.Window != Native.GetForegroundWindow() || saved.Pid != process.Id || Identity(process) != id || saved.Element.Current.BoundingRectangle != saved.Bounds)
            throw new InvalidOperationException("元素引用或位置已失效");
        SafeElement(saved.Element);
        if (!saved.Element.Current.IsEnabled)
            throw new InvalidOperationException("元素不可操作");
        return saved.Element;
    }
    static void FocusSafe(AutomationElement? expected = null)
    {
        var focused = AutomationElement.FocusedElement ?? throw new InvalidOperationException("无法确认输入焦点");
        SafeElement(focused);
        using var process = ProcessOf(Native.GetForegroundWindow());
        if (focused.Current.ProcessId != process.Id || !InWindow(focused, Native.GetForegroundWindow()))
            throw new InvalidOperationException("输入焦点不属于目标窗口");
        if (expected != null && !Automation.Compare(expected, focused))
            throw new InvalidOperationException("输入焦点与目标不一致");
    }
    static bool InWindow(AutomationElement element, nint window)
    {
        for (int i = 0; i < 80 && element != null; i++)
        {
            int handle = element.Current.NativeWindowHandle;
            if (handle != 0 && Native.GetAncestor((nint)handle, 2) == window)
                return true;
            element = TreeWalker.ControlViewWalker.GetParent(element);
        }
        return false;
    }
    public object? Execute(string cmd, JsonElement a, long generation)
    {
        if (cmd == "permissions")
        {
            bool safe;
            try
            {
                Native.SafeDesktop();
                safe = true;
            }
            catch { safe = false; }
            return new
            {
                accessibility = safe,
                screenRecording = safe
            };
        }
        if (cmd == "watch_user_input")
        {
            Native.SafeDesktop();
            safety.Arm(generation);
            return null;
        }
        Native.SafeDesktop();
        safety.Check(generation);
        if (cmd == "apps")
        {
            var apps = new List<object>();
            var seen = new HashSet<string>();
            foreach (var h in Windows())
                try
                {
                    using var p = ProcessOf(h);
                    if (seen.Add(Identity(p)))
                        apps.Add(App(h));
                }
                catch { }
            return apps;
        }
        if (cmd == "frontmost")
            return App(Native.GetForegroundWindow());
        if (cmd == "window_at")
            return App(Native.WindowFromPoint(new Native.POINT { x = (int)a.Number("x"), y = (int)a.Number("y") }));
        if (cmd == "resolve")
        {
            var query = a.Text("app");
            foreach (var h in Windows())
                try
                {
                    using var p = ProcessOf(h);
                    if (Identity(p).Equals(query, StringComparison.OrdinalIgnoreCase) || p.ProcessName.Equals(query, StringComparison.OrdinalIgnoreCase) || DisplayName(p).Equals(query, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(Identity(p)).Equals(query, StringComparison.OrdinalIgnoreCase))
                        return App(h);
                }
                catch { }
            string? path = null;
            if (Path.IsPathFullyQualified(query) && File.Exists(query) && Path.GetExtension(query).Equals(".exe", StringComparison.OrdinalIgnoreCase))
                path = Path.GetFullPath(query);
            else if (Path.GetFileName(query) == query)
            foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                using var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + (query.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? query : query + ".exe"));
                if (key?.GetValue(null) is string registered && Path.IsPathFullyQualified(registered) && File.Exists(registered))
                {
                    path = registered;
                    break;
                }
            }
            if (path == null)
                throw new InvalidOperationException("未找到应用");
            return new
            {
                bundleId = Path.GetFullPath(path).ToLowerInvariant(),
                name = Path.GetFileNameWithoutExtension(path),
                pid = 0,
                windows = Array.Empty<string>()
            };
        }
        string id = a.Text("bundleId").ToLowerInvariant();
        if (!Path.IsPathFullyQualified(id) || !id.EndsWith(".exe"))
            throw new InvalidOperationException("无效应用标识");
        if (cmd == "activate")
        {
            safety.Require(generation);
            nint h;
            try
            {
                h = Find(id);
            }
            catch
            {
                bool hasWindow = false;
                foreach (var candidate in Windows())
                    try
                    {
                        using var process = ProcessOf(candidate);
                        if (Identity(process) == id)
                            hasWindow = true;
                    }
                    catch { }
                if (hasWindow || !File.Exists(id))
                    throw;
                safety.Require(generation);
                Process.Start(new ProcessStartInfo(id) { UseShellExecute = false });
                h = 0;
                for (int i = 0; i < 50; i++)
                {
                    safety.Require(generation);
                    Thread.Sleep(100);
                    try
                    {
                        h = Find(id);
                        break;
                    }
                    catch { }
                }
                if (h == 0)
                    throw new InvalidOperationException("应用启动后没有窗口");
            }
            using (var target = ProcessOf(h))
            using (var self = Process.GetCurrentProcess())
            {
                if (Native.Integrity(target) > Native.Integrity(self))
                    throw new InvalidOperationException("拒绝操作高权限应用");
            }
            if (Native.IsIconic(h))
                Native.ShowWindow(h, 9);
            Native.SetForegroundWindow(h);
            for (int i = 0; i < 20; i++)
            {
                safety.Require(generation);
                if (Native.GetForegroundWindow() == h)
                    break;
                Thread.Sleep(50);
            }
            Guard(id, generation, true);
            return App(h);
        }
        Guard(id, generation);
        var window = Native.GetForegroundWindow();
        if (cmd == "ax_tree")
        {
            refs.Clear();
            serial++;
            var nodes = new List<object>();
            var deadline = DateTime.UtcNow.AddSeconds(5);
            int visited = 0;
            var seen = new HashSet<string>();
            void Walk(AutomationElement element, int depth, int visibleDepth)
            {
                safety.Check(generation);
                if (DateTime.UtcNow > deadline)
                    throw new InvalidOperationException("读取辅助功能树超时");
                if (depth >= 80 || visited++ >= 6000 || refs.Count >= 1500)
                    return;
                if (!seen.Add(string.Join(":", element.GetRuntimeId())))
                    return;
                var c = element.Current;
                bool password = c.IsPassword;
                string role = c.ControlType == ControlType.Edit ? "AXTextArea" : c.ControlType == ControlType.Button ? "AXButton" : c.ControlType.ProgrammaticName.Replace("ControlType.", "AX");
                string value = "";
                if (!password && element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
                    value = ((ValuePattern)pattern).Current.Value;
                else if (!password && (c.ControlType == ControlType.Edit || c.ControlType == ControlType.Document) && element.TryGetCurrentPattern(TextPattern.Pattern, out var textPattern))
                    value = ((TextPattern)textPattern).DocumentRange.GetText(1500);
                bool empty = c.ControlType == ControlType.Pane && string.IsNullOrEmpty(c.Name);
                if (!empty)
                {
                    var key = $"{serial}:{refs.Count}";
                    refs[key] = (element, c.ProcessId, c.BoundingRectangle, window, generation);
                    nodes.Add(new
                    {
                        id = key,
                        role,
                        title = password ? "密码输入框" : c.Name,
                        value = password ? "" : value[..Math.Min(1500, value.Length)],
                        identifier = password ? "" : c.AutomationId,
                        focused = !password && c.HasKeyboardFocus,
                        enabled = !password && c.IsEnabled,
                        depth = visibleDepth,
                        frame = Rect(c.BoundingRectangle)
                    });
                }
                if (password)
                    return;
                var child = TreeWalker.ControlViewWalker.GetFirstChild(element);
                while (child != null)
                {
                    Walk(child, depth + 1, empty ? visibleDepth : visibleDepth + 1);
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
            }
            var focused = AutomationElement.FocusedElement;
            using (var process = ProcessOf(window))
            {
                if (focused != null && focused.Current.ProcessId == process.Id && InWindow(focused, window))
                {
                    bool safe = true;
                    try
                    {
                        SafeElement(focused);
                    }
                    catch (InvalidOperationException) { safe = false; }
                    if (safe)
                        Walk(focused, 0, 0);
                }
            }
            Walk(AutomationElement.FromHandle(window), 0, 0);
            Guard(id, generation);
            return new
            {
                app = App(window),
                nodes
            };
        }
        if (cmd == "screenshot")
        {
            Native.GetWindowRect(window, out var before);
            int width = before.right - before.left, height = before.bottom - before.top;
            if (width <= 0 || height <= 0 || (long)width * height > 40_000_000)
                throw new InvalidOperationException("窗口截图尺寸无效");
            using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var dc = graphics.GetHdc();
                try
                {
                    if (!Native.PrintWindow(window, dc, 2))
                        throw new InvalidOperationException("目标窗口不支持截图");
                }
                finally { graphics.ReleaseHdc(dc); }
            }
            Guard(id, generation);
            Native.GetWindowRect(window, out var after);
            if (Native.GetForegroundWindow() != window || !before.Equals(after))
                throw new InvalidOperationException("截图期间窗口已改变");
            double ratio = Math.Min(1, 1568.0 / Math.Max(width, height));
            int imageWidth = Math.Max(1, (int)(width * ratio)), imageHeight = Math.Max(1, (int)(height * ratio));
            using var resized = new Bitmap(imageWidth, imageHeight, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(resized))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(bitmap, 0, 0, imageWidth, imageHeight);
            }
            using var stream = new MemoryStream();
            resized.Save(stream, ImageFormat.Jpeg);
            Guard(id, generation);
            return new
            {
                data = Convert.ToBase64String(stream.ToArray()),
                width = imageWidth,
                height = imageHeight,
                bounds = new
                {
                    x = before.left,
                    y = before.top,
                    width,
                    height
                }
            };
        }
        Guard(id, generation, true);
        var node = Node(a, id);
        if (cmd == "type")
        {
            if (node != null)
                node.SetFocus();
            FocusSafe(node);
            string text = a.Text("text");
            if (text.Length > 20000)
                throw new InvalidOperationException("输入文本过长");
            foreach (var chunk in UnicodeChunks(text))
            {
                Guard(id, generation, true);
                FocusSafe(node);
                Guard(id, generation, true);
                safety.Send(generation, chunk.SelectMany(unit => new[] { Native.Key(unit, false, true), Native.Key(unit, true, true) }).ToArray(), window);
                Thread.Sleep(1);
            }
            return null;
        }
        if (cmd == "key")
        {
            FocusSafe();
            var combo = a.Text("combo");
            if (combo.Length > 100)
                throw new InvalidOperationException("按键组合过长");
            var parts = combo.ToLowerInvariant().Split('+');
            var keys = new List<ushort>();
            foreach (var p in parts)
                keys.Add(KeyCode(p));
            Guard(id, generation, true);
            safety.Send(generation, keys.Select(k => Native.Key(k)).Concat(keys.AsEnumerable().Reverse().Select(k => Native.Key(k, true))).ToArray(), window);
            return null;
        }
        if (cmd is "click" or "scroll")
        {
            var bounds = node?.Current.BoundingRectangle;
            double px = a.Number("x", bounds?.X + bounds?.Width / 2 ?? double.NaN), py = a.Number("y", bounds?.Y + bounds?.Height / 2 ?? double.NaN);
            if (!double.IsFinite(px) || !double.IsFinite(py) || px < int.MinValue || px > int.MaxValue || py < int.MinValue || py > int.MaxValue)
                throw new InvalidOperationException("需要有效元素引用或截图坐标");
            int x = (int)px, y = (int)py;
            var point = new Native.POINT { x = x, y = y };
            using var hit = ProcessOf(Native.WindowFromPoint(point));
            if (Identity(hit) != id)
                throw new InvalidOperationException("坐标不属于目标应用");
            SafeElement(AutomationElement.FromPoint(new System.Windows.Point(x, y)));
            int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77), vw = Native.GetSystemMetrics(78), vh = Native.GetSystemMetrics(79);
            var move = Native.Mouse(0x8000 | 0x4000 | 1, (int)((x - vx) * 65535L / Math.Max(1, vw - 1)), (int)((y - vy) * 65535L / Math.Max(1, vh - 1)));
            Guard(id, generation, true);
            if (cmd == "click")
            {
                uint down = a.Text("button") == "right" ? 8u : 2u;
                for (int i = 0; i < (a.Bool("double") ? 2 : 1); i++)
                {
                    Guard(id, generation, true);
                    safety.Send(generation, new[] { move, Native.Mouse(down), Native.Mouse(down * 2) }, window, point);
                }
            }
            else
                safety.Send(generation, new[] { move, Native.Mouse(0x800, data: -(int)a.Number("dy")), Native.Mouse(0x1000, data: (int)a.Number("dx")) }, window, point);
            return null;
        }
        throw new InvalidOperationException("未知命令");
    }
    internal static IEnumerable<string> UnicodeChunks(string text)
    {
        var chunk = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            if (chunk.Length + rune.Utf16SequenceLength > 16)
            {
                yield return chunk.ToString();
                chunk.Clear();
            }
            chunk.Append(rune.ToString());
        }
        if (chunk.Length > 0)
            yield return chunk.ToString();
    }
    internal static ushort KeyCode(string key) => key switch { "cmd" or "command" or "meta" or "win" => 0x5b, "ctrl" or "control" => 0x11, "alt" or "option" => 0x12, "shift" => 0x10, "enter" or "return" => 13, "tab" => 9, "escape" or "esc" => 27, "space" => 32, "backspace" => 8, "delete" or "forwarddelete" => 46, "left" => 37, "up" => 38, "right" => 39, "down" => 40, "home" => 36, "end" => 35, "pageup" => 33, "pagedown" => 34, ";" => 0xba, "=" => 0xbb, "," => 0xbc, "-" => 0xbd, "." => 0xbe, "/" => 0xbf, "`" => 0xc0, "[" => 0xdb, "\\" => 0xdc, "]" => 0xdd, "'" => 0xde, _ when key.StartsWith("f") && int.TryParse(key.AsSpan(1), out var f) && f is >= 1 and <= 24 => (ushort)(0x70 + f - 1), _ when key.Length == 1 && char.IsAsciiLetterOrDigit(key[0]) => (ushort)char.ToUpperInvariant(key[0]), _ => throw new InvalidOperationException("不支持的按键组合") };
}
