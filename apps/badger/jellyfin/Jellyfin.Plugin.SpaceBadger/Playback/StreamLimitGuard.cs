using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>The sidecar's stream-place routes (SidecarClient in the plugin, a fake in tests).</summary>
public interface IStreamPlaceSidecar
{
    Task<SbStreamAnswer> StartAsync(string session, string item, string? deviceName, string language, CancellationToken ct);

    Task<SbStreamAnswer> PollAsync(string session, string language, CancellationToken ct);

    Task StopAsync(string session, CancellationToken ct);
}

/// <summary>What the guard does to a Jellyfin session (ISessionManager in the plugin, a fake in tests).</summary>
public interface IStreamPlacePlayers
{
    Task ShowMessageAsync(string session, string text, CancellationToken ct);

    Task StopPlaybackAsync(string session, CancellationToken ct);
}

/// <summary>
/// ACCT-STREAM-01..04 for Jellyfin playbacks of Badger items. A start asks the sidecar for the server's stream place
/// (it heartbeats and frees it); at the limit the viewer gets "Already playing on &lt;device&gt;. Play here instead?"
/// and the playback is stopped. Jellyfin clients have no server-opened yes/no dialog, so starting the same title
/// again within the sidecar's window is Play here. While playing, every progress report checks the place: when another
/// device took it the viewer gets "Playing on &lt;device&gt; now" and the playback stops. A stop gives the place back.
/// The service unreachable plays without a place (ACCT-STREAM-05 option A, as the shared gate does).
/// </summary>
public sealed class StreamLimitGuard
{
    private readonly IStreamPlaceSidecar _sidecar;
    private readonly IStreamPlacePlayers _players;
    private readonly ILogger _logger;

    public StreamLimitGuard(IStreamPlaceSidecar sidecar, IStreamPlacePlayers players, ILogger logger)
    {
        _sidecar = sidecar;
        _players = players;
        _logger = logger;
    }

    /// <summary>A Badger item started in a session. Returns true when it may play.</summary>
    public async Task<bool> OnStartAsync(string session, string item, string? deviceName, string language, CancellationToken ct)
    {
        SbStreamAnswer answer;
        try
        {
            answer = await _sidecar.StartAsync(session, item, deviceName, language, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "SpaceBadger stream place unavailable for session {Session}: playing without one", session);
            return true;
        }

        _logger.LogInformation("SpaceBadger stream place for session {Session} item {Item}: {Status} takeover={Takeover}", session, item, answer.Status, answer.Takeover);
        if (answer.Status != "limit")
        {
            return true;
        }

        await TellAndStopAsync(session, answer.Text, ct).ConfigureAwait(false);
        return false;
    }

    /// <summary>A progress report of a Badger item. Returns true while the session may keep playing.</summary>
    public async Task<bool> OnProgressAsync(string session, string language, CancellationToken ct)
    {
        SbStreamAnswer answer;
        try
        {
            answer = await _sidecar.PollAsync(session, language, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "SpaceBadger stream place check failed for session {Session}", session);
            return true;
        }

        if (answer.Status != "takenOver")
        {
            return true;
        }

        _logger.LogInformation("SpaceBadger stream place of session {Session} was taken by another device", session);
        await TellAndStopAsync(session, answer.Text, ct).ConfigureAwait(false);
        return false;
    }

    /// <summary>A Badger item stopped in a session: its place, if it holds one, is given back.</summary>
    public async Task OnStoppedAsync(string session, CancellationToken ct)
    {
        try
        {
            await _sidecar.StopAsync(session, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "SpaceBadger could not free the stream place of session {Session}", session);
        }
    }

    private async Task TellAndStopAsync(string session, string? text, CancellationToken ct)
    {
        if (text is { Length: > 0 })
        {
            try
            {
                await _players.ShowMessageAsync(session, text, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "SpaceBadger could not message session {Session}", session);
            }
        }

        try
        {
            await _players.StopPlaybackAsync(session, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "SpaceBadger could not stop the playback of session {Session}", session);
        }
    }
}
