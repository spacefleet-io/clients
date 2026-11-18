using System.Diagnostics;
using System.Security.Cryptography;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.SpaceBadger.Tests;

public sealed class VerifiedBinaryTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("sf-jf-binary-").FullName;
    private readonly ITestOutputHelper _output;

    public VerifiedBinaryTests(ITestOutputHelper output)
    {
        _output = output;
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    // @req INTG-JF-05[badger-jellyfin]
    [Fact]
    public async Task SecondStartWithUnchangedBinaryDoesNotReadIt()
    {
        var (target, sha) = WriteBinary(64 * 1024 * 1024);

        var watch = Stopwatch.StartNew();
        Assert.Equal(BinaryCheck.MatchedHash, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));
        var fullMs = watch.Elapsed.TotalMilliseconds;
        Assert.True(File.Exists(VerifiedBinary.StampPath(target)));

        // An exclusive lock makes any open of the binary fail, so a match proves the file was not read.
        using (new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.Throws<IOException>(() => File.OpenRead(target).Dispose());
            watch.Restart();
            Assert.Equal(BinaryCheck.MatchedStamp, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));
            _output.WriteLine($"64 MiB binary: first start (full hash) {fullMs:F1} ms, second start (stamp) {watch.Elapsed.TotalMilliseconds:F2} ms");
        }
    }

    // @req INTG-JF-05[badger-jellyfin]
    [Fact]
    public async Task TamperedBinaryOfTheSameSizeIsCaught()
    {
        var (target, sha) = WriteBinary(1024 * 1024);
        Assert.Equal(BinaryCheck.MatchedHash, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));

        await using (var stream = new FileStream(target, FileMode.Open, FileAccess.Write))
        {
            stream.Position = 4096;
            stream.WriteByte(0xFF);
        }

        File.SetLastWriteTimeUtc(target, File.GetLastWriteTimeUtc(target).AddSeconds(1));
        Assert.Equal(BinaryCheck.Mismatch, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));
        Assert.False(File.Exists(VerifiedBinary.StampPath(target)));
    }

    // @req INTG-JF-05[badger-jellyfin]
    [Fact]
    public async Task ReplacedBinaryIsCaught()
    {
        var (target, sha) = WriteBinary(1024 * 1024);
        Assert.Equal(BinaryCheck.MatchedHash, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));

        var swap = Path.Combine(_dir, "swap");
        File.WriteAllBytes(swap, RandomNumberGenerator.GetBytes(1024 * 1024 + 1));
        File.Move(swap, target, overwrite: true);
        Assert.Equal(BinaryCheck.Mismatch, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));
    }

    // @req INTG-JF-05[badger-jellyfin]
    [Fact]
    public async Task StampForAnotherHashIsNotTrusted()
    {
        var (target, sha) = WriteBinary(1024 * 1024);
        await VerifiedBinary.RecordAsync(target, new string('0', 64), CancellationToken.None);

        Assert.Equal(BinaryCheck.MatchedHash, await VerifiedBinary.CheckAsync(target, sha, CancellationToken.None));
        Assert.Equal(BinaryCheck.Mismatch, await VerifiedBinary.CheckAsync(target, new string('0', 64), CancellationToken.None));
    }

    private (string Target, string Sha) WriteBinary(int size)
    {
        var bytes = RandomNumberGenerator.GetBytes(size);
        var target = Path.Combine(_dir, "badger-integration-linux-x64");
        File.WriteAllBytes(target, bytes);
        return (target, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }
}
