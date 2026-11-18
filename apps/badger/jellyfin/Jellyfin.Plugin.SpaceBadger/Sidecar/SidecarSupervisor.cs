using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Plugins;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Sidecar;

/// <summary>
/// Starts and supervises the Badger Jellyfin sidecar (INTG-JF-04): restarts it with backoff when it
/// crashes or when the settings it was started with change, and forwards its output to the Jellyfin log.
/// It listens on 127.0.0.1 only (INTG-JF-03).
/// </summary>
public sealed class SidecarSupervisor : IHostedService, IDisposable
{
    private readonly ILogger<SidecarSupervisor> _logger;
    private readonly SidecarDownloader _downloader;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private Process? _process;
    private string _startedWith = string.Empty;

    public SidecarSupervisor(ILogger<SidecarSupervisor> logger, SidecarDownloader downloader, IServerConfigurationManager serverConfig)
    {
        _logger = logger;
        _downloader = downloader;
        _serverConfig = serverConfig;
    }

    /// <summary>Gets a plain-English line about the service download for the settings page.</summary>
    public string DownloadStatus => _downloader.Status;

    /// <summary>Gets a value indicating whether the child process is currently running.</summary>
    public bool IsRunning => _process is { HasExited: false };

    public string? LastStartError { get; private set; }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged += OnConfigurationChanged;
        }

        _serverConfig.ConfigurationUpdated += OnServerConfigurationUpdated;

        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged -= OnConfigurationChanged;
        }

        _serverConfig.ConfigurationUpdated -= OnServerConfigurationUpdated;

        _cts?.Cancel();
        _wake.Release();
        KillProcess("plugin stopping");
        if (_loop is not null)
        {
            try
            {
                await _loop.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
            {
                _logger.LogWarning("SpaceBadger service supervisor did not stop in time");
            }
        }
    }

    public void Dispose()
    {
        _cts?.Dispose();
        _wake.Dispose();
        _process?.Dispose();
    }

    /// <summary>Restarts the service now (settings changed, key written, sign-out).</summary>
    public void Restart(string reason)
    {
        _logger.LogInformation("SpaceBadger service restart requested: {Reason}", reason);
        KillProcess(reason);
        _wake.Release();
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration e) => RestartIfChanged();

    // The service shows synopses and episode names in Jellyfin's interface language (LIB-LANG-01), handed over at start.
    private void OnServerConfigurationUpdated(object? sender, EventArgs e) => RestartIfChanged();

    private void RestartIfChanged()
    {
        var signature = Signature();
        if (!string.Equals(signature, _startedWith, StringComparison.Ordinal) && _process is not null)
        {
            Restart("settings changed");
        }
        else
        {
            _wake.Release();
        }
    }

    private string Signature()
    {
        var config = Plugin.Instance!.Configuration;
        return $"{config.Enabled}|{config.EffectiveApiUrl()}|{config.SidecarPort}|{config.SidecarPath}|{config.SidecarDownloadUrl}|{config.MetadataUrl}|{UiLanguage()}";
    }

    /// <summary>Jellyfin's interface language (as the playback reports send it), English when unset.</summary>
    private string UiLanguage() => _serverConfig.Configuration.UICulture is { Length: > 0 } culture ? culture : "en";

    private async Task RunAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var plugin = Plugin.Instance;
                if (plugin is null || !plugin.Configuration.Enabled)
                {
                    await _wake.WaitAsync(TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);
                    continue;
                }

                string binary;
                try
                {
                    binary = await ResolveBinaryAsync(plugin, ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LastStartError = $"The Badger service is not available: {ex.Message}";
                    _logger.LogError("SpaceBadger service binary not available ({Reason}); retrying in {Backoff}s", ex.Message, backoff.TotalSeconds);
                    await _wake.WaitAsync(backoff, ct).ConfigureAwait(false);
                    backoff = TimeSpan.FromSeconds(Math.Min(300, backoff.TotalSeconds * 2));
                    continue;
                }

                backoff = TimeSpan.FromSeconds(2);

                var startedAt = DateTime.UtcNow;
                await RunProcessAsync(plugin, binary, ct).ConfigureAwait(false);
                if (ct.IsCancellationRequested)
                {
                    break;
                }

                var ranFor = DateTime.UtcNow - startedAt;
                backoff = ranFor > TimeSpan.FromMinutes(1) ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(Math.Min(60, backoff.TotalSeconds * 2));
                _logger.LogWarning("SpaceBadger service exited after {Seconds:F0}s; restarting in {Backoff}s", ranFor.TotalSeconds, backoff.TotalSeconds);
                await _wake.WaitAsync(backoff, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                LastStartError = ex.Message;
                _logger.LogError(ex, "SpaceBadger service supervisor error");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private async Task RunProcessAsync(Plugin plugin, string binary, CancellationToken ct)
    {
        var config = plugin.Configuration;
        Directory.CreateDirectory(plugin.DataDirectory);
        Directory.CreateDirectory(plugin.StateDirectory);

        var info = new ProcessStartInfo(binary)
        {
            WorkingDirectory = plugin.DataDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // Production unless this Jellyfin runs in dev mode (ACCT-AUTH-09); the service applies the same rule itself, since
        // it inherits HEADLESS_DEV_TICKET_KEY from this process.
        info.Environment["HEADLESS_API_URL"] = config.EffectiveApiUrl();
        var metadataUrl = config.MetadataUrl.Trim();
        if (metadataUrl.Length > 0)
        {
            info.Environment["HEADLESS_METADATA_URL"] = metadataUrl;
        }

        info.Environment["HEADLESS_INTEGRATION_PORT"] = config.SidecarPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        info.Environment["HEADLESS_STATE_DIR"] = plugin.StateDirectory;
        info.Environment["HEADLESS_LIBRARY_KEY_FILE"] = plugin.KeyFilePath;
        info.Environment["HEADLESS_CLIENT_TYPE"] = "badger-jellyfin";
        info.Environment["HEADLESS_VERSION"] = plugin.Version.ToString();
        info.Environment["HEADLESS_DEVICE_NAME"] = DeviceName();
        info.Environment["HEADLESS_UI_LANGUAGE"] = UiLanguage();

        EnsureExecutable(binary);
        _startedWith = Signature();
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Forward(e.Data);
        process.ErrorDataReceived += (_, e) => Forward(e.Data);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _process = process;
        LastStartError = null;
        _logger.LogInformation("SpaceBadger service started (pid {Pid}, {Binary}) on 127.0.0.1:{Port}", process.Id, binary, config.SidecarPort);

        try
        {
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger service exited with code {Code}", process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            KillProcess("cancelled");
            throw;
        }
        finally
        {
            _process = null;
            process.Dispose();
        }
    }

    private void Forward(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        // The runtime logs every sqlite checkpoint; keep those out of the info log.
        if (line.Contains("sqlite checkpoint", StringComparison.Ordinal))
        {
            _logger.LogDebug("SpaceBadger service: {Line}", line);
            return;
        }

        _logger.LogInformation("SpaceBadger service: {Line}", line);
    }

    private void KillProcess(string reason)
    {
        var process = _process;
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                _logger.LogInformation("Stopping SpaceBadger service ({Reason})", reason);
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _logger.LogDebug(ex, "SpaceBadger service already gone");
        }
    }

    /// <summary>Gets the name the phone shows when the user approves this server.</summary>
    public string DeviceNameForPairing => DeviceName();

    private string DeviceName()
    {
        var server = _serverConfig.Configuration.ServerName;
        var name = string.IsNullOrWhiteSpace(server) ? "Jellyfin server" : $"Jellyfin: {server.Trim()}";
        return name.Length > 60 ? name[..60] : name;
    }

    private async Task<string> ResolveBinaryAsync(Plugin plugin, CancellationToken ct)
    {
        var configured = plugin.Configuration.SidecarPath;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return File.Exists(configured) ? configured : throw new FileNotFoundException($"The configured service path {configured} does not exist.");
        }

        return await _downloader.EnsureAsync(plugin, ct).ConfigureAwait(false);
    }

    private static void EnsureExecutable(string binary)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        try
        {
            var mode = File.GetUnixFileMode(binary);
            var wanted = mode | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;
            if (mode != wanted)
            {
                File.SetUnixFileMode(binary, wanted);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Surfaces as a start failure with a clear message if it really is not executable.
        }
    }
}
