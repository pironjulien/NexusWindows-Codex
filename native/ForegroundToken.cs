using System.Diagnostics;
using System.IO;
using System.Text.Json;

// The handle is the authority; diagnostics are never used to break a lock.
sealed class ForegroundToken : IDisposable
{
    const long Offset = 1L << 32;
    readonly FileStream stream;
    ForegroundToken(FileStream stream) => this.stream = stream;

    public static ForegroundToken Acquire(string purpose, Task? abandoned = null)
    {
        EmergencyStop.ThrowIfStopped();
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nexus", "foreground.lock");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
        var timer = Stopwatch.StartNew();
        try
        {
            while (true)
            {
                if (abandoned?.IsCompleted == true) throw new OperationCanceledException("Foreground request abandoned");
                try { stream.Lock(Offset, 1); break; }
                catch (IOException)
                {
                    if (timer.ElapsedMilliseconds >= 8000)
                    {
                        stream.Position = 0;
                        var bytes = new byte[4096];
                        var count = stream.Read(bytes, 0, bytes.Length);
                        throw new TimeoutException("Foreground token unavailable; action deferred. Holder: " + System.Text.Encoding.UTF8.GetString(bytes, 0, count));
                    }
                    Thread.Sleep(50);
                }
            }
        }
        catch { stream.Dispose(); throw; }
        // The wait can last up to eight seconds: a stop requested meanwhile refuses the action before any input.
        try { EmergencyStop.ThrowIfStopped(); } catch { stream.Unlock(Offset, 1); stream.Dispose(); throw; }
        var token = new ForegroundToken(stream);
        try
        {
            var data = JsonSerializer.SerializeToUtf8Bytes(new { owner = "NexusCodex", pid = Environment.ProcessId, since = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), purpose });
            stream.SetLength(0);
            stream.Write(data);
            stream.Flush();
            return token;
        }
        catch { token.Dispose(); throw; }
    }

    public void Dispose()
    {
        try { stream.SetLength(0); stream.Flush(); }
        finally { try { stream.Unlock(Offset, 1); } finally { stream.Dispose(); } }
    }
}
