using System.Collections.Concurrent;
using System.Text.Json;

namespace NavoDesktop;

internal static class Program
{
    static readonly object OutputLock = new();
    public static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }
    static void Main(string[] args)
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        if (args.Contains("--self-test"))
        {
            SelfTest.Run();
            return;
        }
        var safety = new Safety();
        var queue = new BlockingCollection<(JsonElement Request, long Generation)>();
        var fake = args.Contains("--fake");
        var worker = new Thread(() =>
        {
            var desktop = fake ? null : new Desktop(safety);
            var fixture = new FakeDesktop(safety);
            foreach (var item in queue.GetConsumingEnumerable())
            {
                var request = item.Request;
                object? id = request.TryGetProperty("id", out var rid) ? rid.Clone() : null;
                try
                {
                    safety.Check(item.Generation);
                    var cmd = request.GetProperty("cmd").GetString() ?? "";
                    var a = request.TryGetProperty("args", out var av) ? av : JsonSerializer.SerializeToElement(new
                    {
                    });
                    var result = fake ? fixture.Execute(cmd, a, item.Generation) : desktop!.Execute(cmd, a, item.Generation);
                    Emit(new
                    {
                        id,
                        ok = true,
                        result
                    });
                }
                catch (Exception e) { Emit(new { id, ok = false, error = e.Message }); }
            }
        })
        {
            IsBackground = true,
            Name = "Navo UI Automation MTA"
        };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            try
            {
                using var json = JsonDocument.Parse(line);
                var request = json.RootElement.Clone();
                var cmd = request.GetProperty("cmd").GetString();
                bool urgent = cmd == "release" || (cmd == "watch_user_input" && request.TryGetProperty("args", out var a) && a.TryGetProperty("enabled", out var on) && !on.GetBoolean());
                if (urgent)
                {
                    safety.Stop();
                    Emit(new
                    {
                        id = request.GetProperty("id").Clone(),
                        ok = true,
                        result = (object?)null
                    });
                }
                else
                    queue.Add((request, safety.Generation));
            }
            catch (Exception e) { Emit(new { id = (object?)null, ok = false, error = e.Message }); }
        }
        safety.Stop();
        queue.CompleteAdding();
        worker.Join(2000);
        safety.Dispose();
    }
}
internal static class Args
{
    public static string Text(this JsonElement a, string name, string fallback = "") => a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
    public static bool Bool(this JsonElement a, string name) => a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    public static double Number(this JsonElement a, string name, double fallback = 0) => a.TryGetProperty(name, out var v) && v.TryGetDouble(out var n) && double.IsFinite(n) ? n : fallback;
}
