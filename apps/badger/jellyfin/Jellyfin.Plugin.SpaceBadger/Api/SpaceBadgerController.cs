using System.Text.Json;
using System.Runtime.InteropServices;
using Jellyfin.Plugin.SpaceBadger.Configuration;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Plugin.SpaceBadger.Sync;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Api;

/// <summary>Admin-only endpoints behind the plugin's settings page.</summary>
[ApiController]
[Route("SpaceBadger")]
[Authorize(Policy = "RequiresElevation")]
public sealed class SpaceBadgerController : ControllerBase
{
    private readonly SidecarClient _client;
    private readonly SidecarSupervisor _supervisor;
    private readonly LibrarySynchronizer _synchronizer;
    private readonly OwnerService _owner;
    private readonly ILogger<SpaceBadgerController> _logger;

    public SpaceBadgerController(
        SidecarClient client,
        SidecarSupervisor supervisor,
        LibrarySynchronizer synchronizer,
        OwnerService owner,
        ILogger<SpaceBadgerController> logger)
    {
        _client = client;
        _supervisor = supervisor;
        _synchronizer = synchronizer;
        _owner = owner;
        _logger = logger;
    }

    public sealed class LoginRequest
    {
        public string Email { get; set; } = string.Empty;

        public string Password { get; set; } = string.Empty;

        public string? TwoFactorCode { get; set; }

        public string? ApiUrl { get; set; }
    }

    public sealed class KeyRequest
    {
        public string Key { get; set; } = string.Empty;
    }

    [HttpGet("Status")]
    public async Task<ActionResult> GetStatus(CancellationToken ct)
    {
        var plugin = Plugin.Instance!;
        SbStatus? status = null;
        string? serviceError = null;
        try
        {
            status = await _client.GetStatusAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or TaskCanceledException)
        {
            serviceError = ex.Message;
        }

        var body = new
        {
            service = status,
            serviceRunning = _supervisor.IsRunning,
            // The dashboard shows the server address field in dev mode only (ACCT-AUTH-09).
            serverPicker = PluginConfiguration.DevMode,
            serviceError = serviceError ?? _supervisor.LastStartError,
            downloadStatus = _supervisor.DownloadStatus,
            keyFilePresent = System.IO.File.Exists(plugin.KeyFilePath),
            keyFilePath = plugin.KeyFilePath,
            libraryRoot = plugin.LibraryRoot,
            owner = _owner.GetOwner()?.Username,
            lastSyncAt = _synchronizer.LastSyncAt,
            lastSyncError = _synchronizer.LastSyncError,
            lastChangedFiles = _synchronizer.LastChangedFiles,
        };
        return Content(JsonSerializer.Serialize(body, SidecarClient.Json), "application/json");
    }

    public sealed class PairRequest
    {
        public string? ApiUrl { get; set; }
    }

    /// <summary>Starts a pairing code the user approves from their phone or desktop (ACCT-PAIR-01). The service does the crypto; the key never passes through here.</summary>
    [HttpPost("Pair/Start")]
    public async Task<ActionResult> StartPairing([FromBody] PairRequest? request, CancellationToken ct)
    {
        // A requested server counts in dev mode only (ACCT-AUTH-09); otherwise the service uses production.
        var apiUrl = !PluginConfiguration.DevMode || string.IsNullOrWhiteSpace(request?.ApiUrl) ? null : request.ApiUrl.Trim().TrimEnd('/');
        try
        {
            var pairing = await _client.StartPairingAsync(_supervisor.DeviceNameForPairing, apiUrl, ct).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger pairing code requested for {Device} (expires {Expires})", pairing.DeviceName, pairing.ExpiresAt);
            return Content(JsonSerializer.Serialize(pairing, SidecarClient.Json), "application/json");
        }
        catch (SbSidecarException ex)
        {
            _logger.LogWarning("SpaceBadger pairing could not start: {Status} {Body}", ex.StatusCode, ex.Body);
            return StatusCode(ex.StatusCode is >= 400 and < 500 and not 401 and not 403 ? ex.StatusCode : 502, ex.Body ?? ex.Message);
        }
    }

    [HttpPost("Pair/Cancel")]
    public async Task<ActionResult> CancelPairing(CancellationToken ct)
    {
        await _client.CancelPairingAsync(ct).ConfigureAwait(false);
        return NoContent();
    }

    [HttpPost("Login")]
    public async Task<ActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
    {
        // A requested server counts in dev mode only (ACCT-AUTH-09); otherwise the service uses production.
        var apiUrl = !PluginConfiguration.DevMode || string.IsNullOrWhiteSpace(request.ApiUrl) ? null : request.ApiUrl.Trim().TrimEnd('/');
        try
        {
            // The password goes straight to the local service, which keeps only the session token (never the password).
            // The service remembers the server URL it signed in against.
            var status = await _client.LoginAsync(request.Email, request.Password, request.TwoFactorCode, apiUrl, ct).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger sign-in as {Email} against {ApiUrl} succeeded (service state {State})", status.Email, apiUrl ?? "default", status.State);
            return Ok(status);
        }
        catch (SbSidecarException ex)
        {
            _logger.LogWarning("SpaceBadger sign-in failed: {Status} {Body}", ex.StatusCode, ex.Body);
            // Never relay 401/403: the dashboard would read them as an expired Jellyfin session.
            return StatusCode(ex.StatusCode is >= 400 and < 500 and not 401 and not 403 ? ex.StatusCode : 502, ex.Body ?? ex.Message);
        }
    }

    public sealed class ProfileRequest
    {
        public string ProfileId { get; set; } = string.Empty;
    }

    /// <summary>The account's profiles and the one this server follows (INTG-PROF-01).</summary>
    [HttpGet("Profiles")]
    public async Task<ActionResult> GetProfiles(CancellationToken ct)
    {
        try
        {
            var profiles = await _client.GetProfilesAsync(ct).ConfigureAwait(false);
            return Content(JsonSerializer.Serialize(profiles, SidecarClient.Json), "application/json");
        }
        catch (SbSidecarException ex)
        {
            _logger.LogWarning("SpaceBadger profile list failed: {Status} {Body}", ex.StatusCode, ex.Body);
            return StatusCode(ex.StatusCode is >= 400 and < 500 and not 401 and not 403 ? ex.StatusCode : 502, ex.Body ?? ex.Message);
        }
    }

    /// <summary>
    /// Picks the followed profile (INTG-PROF-01): finishes a pairing waiting for the pick, or changes it later. The
    /// synced media stay; the service's change feed moves, so the next sync re-applies resume and watched marks to the
    /// owner's Jellyfin user, and track choices are read from the new profile.
    /// </summary>
    [HttpPost("Profile")]
    public async Task<ActionResult> ChooseProfile([FromBody] ProfileRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.ProfileId))
        {
            return BadRequest("profileId required");
        }

        try
        {
            var status = await _client.ChooseProfileAsync(request.ProfileId.Trim(), ct).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger now follows profile {ProfileId} ({Name}, main {IsMain}); service state {State}", status.Profile?.Id, status.Profile?.Name, status.Profile?.IsMain, status.State);
            return Content(JsonSerializer.Serialize(status, SidecarClient.Json), "application/json");
        }
        catch (SbSidecarException ex)
        {
            _logger.LogWarning("SpaceBadger profile pick failed: {Status} {Body}", ex.StatusCode, ex.Body);
            // Never relay 401/403: the dashboard would read them as an expired Jellyfin session.
            return StatusCode(ex.StatusCode is >= 400 and < 500 and not 401 and not 403 ? ex.StatusCode : 502, ex.Body ?? ex.Message);
        }
    }

    [HttpPost("Key")]
    public ActionResult SaveKey([FromBody] KeyRequest request)
    {
        var text = (request.Key ?? string.Empty).Trim();
        byte[] decoded;
        try
        {
            decoded = Convert.FromBase64String(text);
        }
        catch (FormatException)
        {
            return BadRequest("The library key is not valid base64.");
        }

        if (decoded.Length != 32)
        {
            return BadRequest($"The library key must be 32 bytes, got {decoded.Length}.");
        }

        var plugin = Plugin.Instance!;
        Directory.CreateDirectory(plugin.DataDirectory);
        // PRIV-KEY-04: the key sits in a private file (0600 where the OS supports it); the settings page says so.
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using (var stream = new FileStream(plugin.KeyFilePath, options))
        using (var writer = new StreamWriter(stream))
        {
            writer.Write(text);
        }

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            System.IO.File.SetUnixFileMode(plugin.KeyFilePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        _logger.LogInformation("SpaceBadger library key stored in {Path} (private file)", plugin.KeyFilePath);
        return NoContent();
    }

    [HttpPost("SignOut")]
    public async Task<ActionResult> SignOutService(CancellationToken ct)
    {
        try
        {
            await _client.SignOutAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException)
        {
            _logger.LogWarning(ex, "SpaceBadger sign-out: service not reachable, removing the key file directly");
        }

        var plugin = Plugin.Instance!;
        if (System.IO.File.Exists(plugin.KeyFilePath))
        {
            System.IO.File.Delete(plugin.KeyFilePath);
        }

        await _synchronizer.RemoveGeneratedLibraryAsync("signed out from the settings page").ConfigureAwait(false);
        return NoContent();
    }

    [HttpPost("Sync")]
    public async Task<ActionResult> SyncNow(CancellationToken ct)
    {
        try
        {
            await _synchronizer.SyncNowAsync(ct).ConfigureAwait(false);
            return NoContent();
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(ex.Message);
        }
    }
}
