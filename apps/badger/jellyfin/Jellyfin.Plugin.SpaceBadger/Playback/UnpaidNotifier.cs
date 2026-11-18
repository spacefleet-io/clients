using System.Collections.Concurrent;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>
/// ACCT-UNPAID-03: while the Badger subscription is unpaid the service answers 402 <c>subscription_unpaid</c>
/// (with the wipe date) for playback. Jellyfin only sees a failed stream, so the viewer gets an on-screen message.
/// </summary>
public sealed class UnpaidNotifier
{
    private readonly SidecarClient _client;
    private readonly ISessionManager _sessions;
    private readonly ILogger<UnpaidNotifier> _logger;
    private readonly ConcurrentDictionary<Guid, DateTime> _lastNotified = new();

    public UnpaidNotifier(SidecarClient client, ISessionManager sessions, ILogger<UnpaidNotifier> logger)
    {
        _client = client;
        _sessions = sessions;
        _logger = logger;
    }

    /// <summary>Checks the subscription and, when unpaid, tells the user's sessions. Returns true if unpaid.</summary>
    public async Task<bool> CheckAndNotifyAsync(Guid userId, CancellationToken ct)
    {
        SbStatus status;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            status = await _client.GetStatusAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or OperationCanceledException)
        {
            _logger.LogDebug(ex, "SpaceBadger status unavailable for the unpaid check");
            return false;
        }

        if (status.AccessState != "unpaid")
        {
            return false;
        }

        if (_lastNotified.TryGetValue(userId, out var last) && DateTime.UtcNow - last < TimeSpan.FromSeconds(30))
        {
            return true;
        }

        _lastNotified[userId] = DateTime.UtcNow;
        var text = status.WipeAt is { Length: > 0 } wipe
            ? $"Your Badger subscription is unpaid, so playback is paused. Your media will be removed on {WipeDate.Format(wipe)} unless you pay."
            : "Your Badger subscription is unpaid, so playback is paused.";
        foreach (var session in _sessions.Sessions.Where(s => s.UserId == userId))
        {
            try
            {
                await _sessions.SendMessageCommand(
                    session.Id,
                    session.Id,
                    new MessageCommand { Header = "Badger subscription unpaid", Text = text, TimeoutMs = 15000 },
                    ct).ConfigureAwait(false);
                _logger.LogInformation("SpaceBadger unpaid message sent to session {Session} ({Device}) of user {User}", session.Id, session.DeviceName, userId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "SpaceBadger could not message session {Session}", session.Id);
            }
        }

        return true;
    }
}
