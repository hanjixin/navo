using System.Text.Json;
namespace NavoDesktop;

internal static class SelfTest
{
    public static void Run()
    {
        if (System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>() != 40)
            throw new Exception("Windows 64-bit INPUT must be 40 bytes");
        string sample = new string('a', 15) + "🌍测试" + new string('b', 30);
        var chunks = Desktop.UnicodeChunks(sample).ToArray();
        if (string.Concat(chunks) != sample || chunks.Any(c => c.Length > 16 || char.IsHighSurrogate(c[^1]) || char.IsLowSurrogate(c[0])))
            throw new Exception("UTF16 chunk boundary corruption");
        if (Desktop.KeyCode("delete") != 46 || Desktop.KeyCode("backspace") != 8 || Desktop.KeyCode("f24") != 135 || Desktop.KeyCode("ctrl") != 17)
            throw new Exception("Key conversion mismatch");
        var unicode = Native.Key('测', true, true);
        if (unicode.type != 1 || unicode.data.key.vk != 0 || unicode.data.key.scan != '测' || unicode.data.key.flags != 6 || unicode.data.key.extra != Native.Marker)
            throw new Exception("Unicode INPUT layout mismatch");
        using var safety = new Safety();
        var fake = new FakeDesktop(safety);
        JsonElement A(object value) => JsonSerializer.SerializeToElement(value);
        void Reject(Action action)
        {
            try
            {
                action();
            }
            catch (InvalidOperationException) { return; }
            throw new Exception("Expected rejection");
        }
        var generation = safety.Generation;
        Reject(() => fake.Execute("type", A(new { text = "x" }), generation));
        fake.Execute("watch_user_input", A(new
        {
            enabled = true
        }), generation);
        var first = JsonSerializer.SerializeToElement(fake.Execute("ax_tree", A(new
        {
        }), generation));
        string reference = first.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        fake.Execute("type", A(new
        {
            text = "测试指令",
            @ref = reference
        }), generation);
        var second = JsonSerializer.SerializeToElement(fake.Execute("ax_tree", A(new
        {
        }), generation));
        if (!second.GetProperty("nodes")[0].GetProperty("value").GetString()!.Contains("测试指令"))
            throw new Exception("Unicode mismatch");
        Reject(() => fake.Execute("click", A(new { @ref = reference }), generation));
        var typing = Task.Run(() => { try { fake.Execute("type", A(new { text = new string('x', 10000) }), generation); return false; } catch (InvalidOperationException) { return true; } });
        Thread.Sleep(30);
        safety.Stop();
        if (!typing.Wait(1000) || !typing.Result)
            throw new Exception("Input did not cancel");
        Reject(() => fake.Execute("key", A(new { combo = "enter" }), generation));
        Reject(() => fake.Execute("activate", A(new { }), safety.Generation));
        var freshGeneration = safety.Generation;
        fake.Execute("watch_user_input", A(new
        {
            enabled = true
        }), freshGeneration);
        var previousReference = second.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        Reject(() => fake.Execute("click", A(new { @ref = previousReference }), freshGeneration));
        Console.WriteLine("PASS native Windows fake: Unicode, fresh refs, urgent cancellation, queued cancellation, stop lock");
    }
}
