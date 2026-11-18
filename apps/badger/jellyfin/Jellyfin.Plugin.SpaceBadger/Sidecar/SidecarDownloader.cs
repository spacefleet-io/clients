using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Sidecar;

/// <summary>
/// Fetches the decrypting service for this server's platform (INTG-JF-04): reads
/// <c>&lt;base&gt;/&lt;plugin version&gt;/manifest.json</c>, downloads the platform binary, checks its SHA-256 and keeps it under
/// <c>&lt;data&gt;/bin/&lt;plugin version&gt;/</c>. A new plugin version downloads a new binary and removes the old ones. At start
/// an unchanged binary is accepted by its stamp instead of a full hash (<see cref="VerifiedBinary"/>, INTG-JF-05).
/// </summary>
public sealed class SidecarDownloader
{
    private readonly ILogger<SidecarDownloader> _logger;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(10) };

    public SidecarDownloader(ILogger<SidecarDownloader> logger)
    {
        _logger = logger;
    }

    /// <summary>Gets a plain-English line about what the downloader is doing, for the settings page.</summary>
    public string Status { get; private set; } = "Waiting to download the Badger service.";

    /// <summary>Gets the last download failure, or null.</summary>
    public string? LastError { get; private set; }

    /// <summary>Gets the platform name used in download URLs, or null when no build exists for this server.</summary>
    public static string? PlatformName()
    {
        var os = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "windows"
            : RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ? "linux"
            : null;
        var arch = RuntimeInformation.OSArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.Arm64 => "arm64",
            _ => null,
        };
        if (os is null || arch is null || (os == "windows" && arch != "x64"))
        {
            return null;
        }

        return $"{os}-{arch}";
    }

    /// <summary>Gets the folder URL the manifest and binaries are served from.</summary>
    public static string BaseUrl(Plugin plugin, string version)
    {
        var configured = plugin.Configuration.SidecarDownloadUrl.Trim().TrimEnd('/');
        var root = configured.Length > 0 ? configured : $"{plugin.Configuration.EffectiveApiUrl()}/integrations/jellyfin/sidecar";
        return $"{root}/{version}";
    }

    /// <summary>Gets the path the binary of the current plugin version lives at.</summary>
    public static string TargetPath(Plugin plugin, string platform)
    {
        var exe = platform.StartsWith("windows", StringComparison.Ordinal) ? ".exe" : string.Empty;
        return Path.Combine(plugin.DataDirectory, "bin", plugin.Version.ToString(), $"badger-integration-{platform}{exe}");
    }

    /// <summary>Returns the verified binary path, downloading it first when it is missing, damaged or from another plugin version.</summary>
    public async Task<string> EnsureAsync(Plugin plugin, CancellationToken ct)
    {
        var platform = PlatformName() ?? throw new InvalidOperationException($"There is no Badger service build for this server ({RuntimeInformation.OSDescription} {RuntimeInformation.OSArchitecture}).");
        var version = plugin.Version.ToString();
        var target = TargetPath(plugin, platform);
        var hashFile = target + ".sha256";

        if (File.Exists(target) && File.Exists(hashFile))
        {
            var expected = (await File.ReadAllTextAsync(hashFile, ct).ConfigureAwait(false)).Trim();
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var check = await VerifiedBinary.CheckAsync(target, expected, ct).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger service binary check: {Check} in {Ms} ms", check, watch.ElapsedMilliseconds);
            if (check != BinaryCheck.Mismatch)
            {
                Status = $"Badger service {version} ({platform}) is installed and checked.";
                return target;
            }

            _logger.LogWarning("SpaceBadger service binary {Path} does not match its recorded hash; downloading it again", target);
        }

        var baseUrl = BaseUrl(plugin, version);
        try
        {
            Status = $"Downloading the Badger service {version} ({platform}) from {baseUrl} ...";
            _logger.LogInformation("SpaceBadger service download: {Status}", Status);
            var manifestText = await _http.GetStringAsync($"{baseUrl}/manifest.json", ct).ConfigureAwait(false);
            using var manifest = JsonDocument.Parse(manifestText);
            if (!manifest.RootElement.TryGetProperty("platforms", out var platforms) || !platforms.TryGetProperty(platform, out var entry))
            {
                throw new InvalidOperationException($"The download manifest has no build for {platform}.");
            }

            var sha256 = entry.GetProperty("sha256").GetString() ?? throw new InvalidOperationException("The download manifest has no sha256.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var partial = target + ".part";
            using (var response = await _http.GetAsync($"{baseUrl}/{platform}", HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                await using var sink = File.Create(partial);
                await source.CopyToAsync(sink, ct).ConfigureAwait(false);
            }

            var actual = await VerifiedBinary.Sha256Async(partial, ct).ConfigureAwait(false);
            if (!string.Equals(actual, sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(partial);
                throw new InvalidOperationException($"The downloaded service does not match its checksum (expected {sha256}, got {actual}); it was discarded.");
            }

            VerifiedBinary.DeleteStamp(target);
            File.Move(partial, target, overwrite: true);
            await File.WriteAllTextAsync(hashFile, actual, ct).ConfigureAwait(false);
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }

            await VerifiedBinary.RecordAsync(target, actual, ct).ConfigureAwait(false);

            RemoveOtherVersions(plugin, version);
            LastError = null;
            Status = $"Badger service {version} ({platform}) downloaded and checked (sha256 {actual[..12]}...).";
            _logger.LogInformation("SpaceBadger service downloaded to {Path} (sha256 {Sha})", target, actual);
            return target;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or JsonException or KeyNotFoundException or TaskCanceledException)
        {
            if (ct.IsCancellationRequested)
            {
                throw;
            }

            LastError = ex.Message;
            Status = "The Badger service could not be downloaded.";
            _logger.LogError(ex, "SpaceBadger service download from {Url} failed", baseUrl);
            throw;
        }
    }

    private void RemoveOtherVersions(Plugin plugin, string keep)
    {
        var root = Path.Combine(plugin.DataDirectory, "bin");
        if (!Directory.Exists(root))
        {
            return;
        }

        foreach (var directory in Directory.GetDirectories(root))
        {
            if (string.Equals(Path.GetFileName(directory), keep, StringComparison.Ordinal))
            {
                continue;
            }

            try
            {
                Directory.Delete(directory, recursive: true);
                _logger.LogInformation("Removed the old SpaceBadger service {Folder}", directory);
            }
            catch (IOException ex)
            {
                _logger.LogWarning(ex, "Could not remove the old SpaceBadger service {Folder}", directory);
            }
        }
    }
}
