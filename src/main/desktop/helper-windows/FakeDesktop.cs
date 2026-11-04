using System.IO;
using System.Text.Json;
namespace NavoDesktop;

internal sealed class FakeDesktop(Safety safety)
{
    string text = "Hello Navo", reference = "fake:0"; int serial; long refGeneration = -1;
    object App => new { bundleId = "com.apple.TextEdit", name = "TextEdit", pid = 123, windows = new[] { "Untitled" } };
    public object? Execute(string cmd, JsonElement a, long generation)
    {
        if (cmd == "permissions")
            return new
            {
                accessibility = true,
                screenRecording = true
            };
        if (cmd == "apps")
            return new[] { App };
        if (cmd == "resolve" || cmd == "frontmost" || cmd == "window_at")
            return App;
        if (cmd == "watch_user_input")
        {
            safety.Arm(generation, true);
            return null;
        }
        safety.Require(generation);
        if (cmd == "activate")
            return App;
        if (cmd == "ax_tree")
        {
            reference = $"fake:{++serial}";
            refGeneration = generation;
            return new
            {
                app = App,
                nodes = new[] { new { id = reference, role = "AXTextArea", title = "Document", value = text, enabled = true, depth = 0, frame = new { x = 0, y = 0, width = 800, height = 600 } } }
            };
        }
        if (cmd == "screenshot")
        {
            using var bitmap = new System.Drawing.Bitmap(800, 600);
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
                graphics.Clear(System.Drawing.Color.White);
            using var stream = new MemoryStream();
            bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Jpeg);
            return new
            {
                data = Convert.ToBase64String(stream.ToArray()),
                width = 800,
                height = 600,
                bounds = new
                {
                    x = 0,
                    y = 0,
                    width = 800,
                    height = 600
                }
            };
        }
        if (a.Text("ref") is var r && r.Length > 0 && (r != reference || refGeneration != generation))
            throw new InvalidOperationException("元素引用已失效");
        if (cmd == "type")
        {
            foreach (var c in a.Text("text"))
            {
                safety.Require(generation);
                text += c;
                Thread.Sleep(1);
            }
            return null;
        }
        if (cmd is "click" or "key" or "scroll")
            return null;
        throw new InvalidOperationException("未知命令");
    }
}
