using System.Globalization;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.SpaceBadger.Sidecar;

/// <summary>How <see cref="VerifiedBinary.CheckAsync"/> settled a binary.</summary>
public enum BinaryCheck
{
    /// <summary>The file still shows the size and times recorded after its last full check: no hash was computed.</summary>
    MatchedStamp,

    /// <summary>The file was read and hashed in full and matches; the stamp was written again.</summary>
    MatchedHash,

    /// <summary>The file was read and hashed in full and does not match.</summary>
    Mismatch,
}

/// <summary>
/// Start-up check of the downloaded sidecar binary (INTG-JF-05). After a full SHA-256 check, the binary's size, modification
/// time and creation time are stored beside it (<c>&lt;binary&gt;.verified</c>) with the hash they were checked against. A later
/// start whose file still shows exactly that stamp skips the full hash; any difference (an updated, replaced or rewritten
/// binary) falls back to the full hash.
/// </summary>
public static class VerifiedBinary
{
    /// <summary>Gets the stamp file kept beside <paramref name="target"/>.</summary>
    public static string StampPath(string target) => target + ".verified";

    /// <summary>Checks <paramref name="target"/> against <paramref name="expectedSha256"/>, by stamp when the file is unchanged, else by full hash.</summary>
    public static async Task<BinaryCheck> CheckAsync(string target, string expectedSha256, CancellationToken ct)
    {
        var stampPath = StampPath(target);
        if (File.Exists(stampPath))
        {
            var stamp = (await File.ReadAllTextAsync(stampPath, ct).ConfigureAwait(false)).Trim();
            if (string.Equals(stamp, Describe(target, expectedSha256), StringComparison.OrdinalIgnoreCase))
            {
                return BinaryCheck.MatchedStamp;
            }
        }

        if (!string.Equals(await Sha256Async(target, ct).ConfigureAwait(false), expectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            DeleteStamp(target);
            return BinaryCheck.Mismatch;
        }

        await RecordAsync(target, expectedSha256, ct).ConfigureAwait(false);
        return BinaryCheck.MatchedHash;
    }

    /// <summary>Records that <paramref name="target"/>, as it is on disk now, was fully checked against <paramref name="sha256"/>.</summary>
    public static Task RecordAsync(string target, string sha256, CancellationToken ct)
        => File.WriteAllTextAsync(StampPath(target), Describe(target, sha256), ct);

    /// <summary>Removes the stamp, so the next check hashes the file in full.</summary>
    public static void DeleteStamp(string target)
    {
        try
        {
            File.Delete(StampPath(target));
        }
        catch (IOException)
        {
            // A stamp that cannot be removed no longer matches a changed file anyway.
        }
    }

    /// <summary>Computes the lowercase hex SHA-256 of a file.</summary>
    public static async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false)).ToLowerInvariant();
    }

    private static string Describe(string target, string sha256)
    {
        var info = new FileInfo(target);
        return string.Create(
            CultureInfo.InvariantCulture,
            $"{sha256.ToLowerInvariant()} {info.Length} {info.LastWriteTimeUtc.Ticks} {info.CreationTimeUtc.Ticks}");
    }
}
