using MediaBrowser.Controller.Entities.TV;
using System.Collections.Concurrent;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Plugin.SpaceBadger.Sync;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Session;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>
/// Writes back what happens in Jellyfin to Badger (INTG-SYNC-01, INTG-JF-01) for the owner's user only:
/// resume position while playing/stopped, watched toggles, the chosen audio language, and deletes (INTG-DEL-01).
/// The 2%/15 s and 95%/credits thresholds are applied by the service so every client shares them.
/// </summary>
public sealed class PlaybackForwarder : IHostedService
{
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromSeconds(30);

    private readonly ISessionManager _sessions;
    private readonly IUserDataManager _userData;
    private readonly ILibraryManager _libraryManager;
    private readonly IMediaSourceManager _mediaSources;
    private readonly IActivityManager _activity;
    private readonly SidecarClient _client;
    private readonly LibraryWriter _writer;
    private readonly OwnerService _owner;
    private readonly UnpaidNotifier _notifier;
    private readonly ILogger<PlaybackForwarder> _logger;
    private readonly IServerConfigurationManager _config;
    private readonly StreamLimitGuard _streams;
    private readonly ConcurrentDictionary<string, DateTime> _lastProgress = new();
    private readonly ConcurrentDictionary<string, (int? Audio, int? Subtitle)> _lastTracks = new();

    public PlaybackForwarder(
        ISessionManager sessions,
        IUserDataManager userData,
        ILibraryManager libraryManager,
        IMediaSourceManager mediaSources,
        IActivityManager activity,
        SidecarClient client,
        LibraryWriter writer,
        OwnerService owner,
        UnpaidNotifier notifier,
        IServerConfigurationManager config,
        ILogger<PlaybackForwarder> logger)
    {
        _sessions = sessions;
        _userData = userData;
        _libraryManager = libraryManager;
        _mediaSources = mediaSources;
        _activity = activity;
        _client = client;
        _writer = writer;
        _owner = owner;
        _notifier = notifier;
        _logger = logger;
        _config = config;
        _streams = new StreamLimitGuard(new SidecarStreamPlace(client), new SessionStreamPlayers(sessions), logger);
    }

    /// <summary>The server's display language for the stream-limit texts (the sidecar falls back to English).</summary>
    private string Language => _config.Configuration.UICulture is { Length: > 0 } culture ? culture : "en";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _sessions.PlaybackStart += OnPlaybackStart;
        _sessions.PlaybackProgress += OnPlaybackProgress;
        _sessions.PlaybackStopped += OnPlaybackStopped;
        _userData.UserDataSaved += OnUserDataSaved;
        _libraryManager.ItemRemoved += OnItemRemoved;
        _logger.LogInformation("SpaceBadger playback/delete forwarding active");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _sessions.PlaybackStart -= OnPlaybackStart;
        _sessions.PlaybackProgress -= OnPlaybackProgress;
        _sessions.PlaybackStopped -= OnPlaybackStopped;
        _userData.UserDataSaved -= OnUserDataSaved;
        _libraryManager.ItemRemoved -= OnItemRemoved;
        return Task.CompletedTask;
    }

    private static bool IsOurs(BaseItem? item) =>
        item?.Path is { } path && Plugin.Instance?.LibraryRoot is { Length: > 0 } root && path.StartsWith(root, StringComparison.Ordinal);

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
    {
        if (!IsOurs(e.Item))
        {
            return;
        }

        _logger.LogInformation("SpaceBadger item playback started: {Item} by {Users} on {Device}", e.Item?.Name, string.Join(",", e.Users.Select(u => u.Username)), e.DeviceName);
        if (e.Session?.Id is { } sessionId)
        {
            // ACCT-STREAM-01/02: every Badger playback on this server takes the profile's stream place.
            _ = _streams.OnStartAsync(sessionId, e.Item!.Id.ToString("N"), e.DeviceName, Language, CancellationToken.None);
        }

        foreach (var user in e.Users)
        {
            _ = _notifier.CheckAndNotifyAsync(user.Id, CancellationToken.None);
        }

        // What the player starts with (the remembered choice, or the default) is not a user choice: never written back.
        _lastTracks.TryAdd(TrackKey(e), (e.Session?.PlayState?.AudioStreamIndex, e.Session?.PlayState?.SubtitleStreamIndex));
    }

    private static string TrackKey(PlaybackProgressEventArgs e) => $"{e.Session?.Id}/{e.Item?.Id}";

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
    {
        if (IsOurs(e.Item) && e.Session?.Id is { } sessionId)
        {
            // ACCT-STREAM-02: another device's Play here stops this one.
            _ = _streams.OnProgressAsync(sessionId, Language, CancellationToken.None);
        }

        _ = ForwardPlaybackAsync(e, stopped: false);
    }

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        if (IsOurs(e.Item) && e.Session?.Id is { } sessionId)
        {
            // ACCT-STREAM-04: the place is given back when playback stops.
            _ = _streams.OnStoppedAsync(sessionId, CancellationToken.None);
        }

        _ = ForwardPlaybackAsync(e, stopped: true);
    }

    private sealed class SidecarStreamPlace : IStreamPlaceSidecar
    {
        private readonly SidecarClient _client;

        public SidecarStreamPlace(SidecarClient client) => _client = client;

        public Task<SbStreamAnswer> StartAsync(string session, string item, string? deviceName, string language, CancellationToken ct) =>
            _client.StartStreamAsync(session, item, deviceName, language, ct);

        public Task<SbStreamAnswer> PollAsync(string session, string language, CancellationToken ct) =>
            _client.PollStreamAsync(session, language, ct);

        public Task StopAsync(string session, CancellationToken ct) => _client.StopStreamAsync(session, ct);
    }

    private sealed class SessionStreamPlayers : IStreamPlacePlayers
    {
        private readonly ISessionManager _sessions;

        public SessionStreamPlayers(ISessionManager sessions) => _sessions = sessions;

        public Task ShowMessageAsync(string session, string text, CancellationToken ct) =>
            _sessions.SendMessageCommand(session, session, new MessageCommand { Header = "Badger", Text = text, TimeoutMs = 15000 }, ct);

        public Task StopPlaybackAsync(string session, CancellationToken ct) =>
            _sessions.SendPlaystateCommand(session, session, new PlaystateRequest { Command = PlaystateCommand.Stop }, ct);
    }

    private async Task ForwardPlaybackAsync(PlaybackProgressEventArgs e, bool stopped)
    {
        try
        {
            if (!IsOurs(e.Item) || !e.Users.Any(u => _owner.IsOwner(u.Id)) || !StrmRef.TryParse(e.Item!.Path, out var reference))
            {
                return;
            }

            // A track switch is a user's choice made now: it is not held back by the 30 s progress interval.
            await ForwardTracksAsync(e, reference, stopped).ConfigureAwait(false);

            var key = $"{reference.MediaId}/{reference.EpisodeId}";
            var now = DateTime.UtcNow;
            if (!stopped && _lastProgress.TryGetValue(key, out var last) && now - last < ProgressInterval)
            {
                return;
            }

            _lastProgress[key] = now;
            var positionSeconds = e.PlaybackPositionTicks is { } ticks ? ticks / (double)TimeSpan.TicksPerSecond : (double?)null;
            var durationSeconds = e.Item.RunTimeTicks is { } run ? run / (double)TimeSpan.TicksPerSecond : (double?)null;
            var result = await _client.PostProgressAsync(reference.MediaId, reference.EpisodeId, positionSeconds, durationSeconds, null, CancellationToken.None).ConfigureAwait(false);
            _logger.LogInformation(
                "SpaceBadger progress {Phase}: {Item} {Position}s/{Duration}s -> recorded={Recorded} {Kind}{Reason}",
                stopped ? "stopped" : "tick",
                e.Item.Name,
                positionSeconds,
                durationSeconds,
                result.Recorded,
                result.Kind,
                result.Reason);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "SpaceBadger could not forward playback progress");
        }
    }

    /// <summary>
    /// PLAY-TRACK-04: the owner's own switch of audio or subtitle track in the player updates the one shared choice of
    /// the movie/show (so every device and app starts the same way). The first report of a play is what the player
    /// started with and is never a choice; other users' choices never leave their Jellyfin account.
    /// </summary>
    private async Task ForwardTracksAsync(PlaybackProgressEventArgs e, StrmRef reference, bool stopped)
    {
        var key = TrackKey(e);
        if (stopped)
        {
            _lastTracks.TryRemove(key, out _);
            return;
        }

        var audioIndex = e.Session?.PlayState?.AudioStreamIndex;
        var subtitleIndex = e.Session?.PlayState?.SubtitleStreamIndex;
        if (!_lastTracks.TryGetValue(key, out var before))
        {
            _lastTracks[key] = (audioIndex, subtitleIndex);
            return;
        }

        var audioSwitched = audioIndex is not null && before.Audio is not null && audioIndex != before.Audio;
        var subtitleSwitched = subtitleIndex is not null && before.Subtitle is not null && subtitleIndex != before.Subtitle;
        _lastTracks[key] = (audioIndex ?? before.Audio, subtitleIndex ?? before.Subtitle);
        if ((!audioSwitched && !subtitleSwitched) || e.Item is null)
        {
            return;
        }

        var streams = _mediaSources.GetMediaStreams(e.Item.Id);
        if (audioSwitched)
        {
            var language = TrackResolver.Normalize(streams.FirstOrDefault(s => s.Type == MediaStreamType.Audio && s.Index == audioIndex)?.Language);
            if (language is null)
            {
                _logger.LogInformation("SpaceBadger audio switch to stream {Index} of {Media} not remembered: the track has no language", audioIndex, reference.MediaId);
            }
            else
            {
                await _client.PostTracksAsync(reference.MediaId, true, language, false, null, CancellationToken.None).ConfigureAwait(false);
                _logger.LogInformation("SpaceBadger audio choice for {Media} -> {Language} (owner switched in {Device})", reference.MediaId, language, e.DeviceName);
            }
        }

        if (subtitleSwitched)
        {
            SubtitleValue? value = null;
            if (subtitleIndex == -1)
            {
                value = SubtitleValue.TurnedOff;
            }
            else if (streams.FirstOrDefault(s => s.Type == MediaStreamType.Subtitle && s.Index == subtitleIndex) is { } stream
                     && TrackResolver.Normalize(stream.Language) is { } language)
            {
                value = new SubtitleValue { Choice = new SubtitleChoice { Language = language, Format = TrackResolver.FormatOf(stream), Forced = stream.IsForced } };
            }

            if (value is null)
            {
                _logger.LogInformation("SpaceBadger subtitle switch to stream {Index} of {Media} not remembered: the track has no language", subtitleIndex, reference.MediaId);
            }
            else
            {
                await _client.PostTracksAsync(reference.MediaId, false, null, true, value, CancellationToken.None).ConfigureAwait(false);
                _logger.LogInformation(
                    "SpaceBadger subtitle choice for {Media} -> {Choice} (owner switched in {Device})",
                    reference.MediaId,
                    value.Off ? "off" : $"{value.Choice!.Language}/{value.Choice.Format}/forced={value.Choice.Forced}",
                    e.DeviceName);
            }
        }
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        // Play/pause tracking is done from the session events; here only explicit "mark played/unplayed" matters.
        // Import (our own resume push) and UpdateUserData are never forwarded: no echo.
        if (e.SaveReason != UserDataSaveReason.TogglePlayed || !IsOurs(e.Item) || !_owner.IsOwner(e.UserId))
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                if (!StrmRef.TryParse(e.Item.Path, out var reference))
                {
                    return;
                }

                var result = await _client.PostProgressAsync(reference.MediaId, reference.EpisodeId, null, null, e.UserData.Played, CancellationToken.None).ConfigureAwait(false);
                _logger.LogInformation("SpaceBadger played toggle: {Item} played={Played} -> {Kind}", e.Item.Name, e.UserData.Played, result.Kind);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "SpaceBadger could not forward the played toggle");
            }
        });
    }

    private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
    {
        if (!IsOurs(e.Item))
        {
            return;
        }

        var item = e.Item;
        var path = item.Path!;
        _ = Task.Run(async () =>
        {
            try
            {
                await ForwardRemovalAsync(item, path).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "SpaceBadger could not forward the delete of {Path}", path);
            }
        });
    }

    private async Task ForwardRemovalAsync(BaseItem item, string path)
    {
        // Only a real delete counts: Jellyfin removed the file itself (and we did not). Removing the library or a
        // rescan leaves the shortcut on disk and must never delete anything from Badger.
        if (_writer.WasRemovedByPlugin(path))
        {
            _logger.LogDebug("SpaceBadger ignoring removal of {Path}: done by the plugin sync", path);
            return;
        }

        if (path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            if (File.Exists(path))
            {
                _logger.LogDebug("SpaceBadger ignoring removal of {Path}: file still on disk", path);
                return;
            }

            if (!StrmRef.TryParse(path, out var reference))
            {
                return;
            }

            if (reference.EpisodeId is not null)
            {
                // A whole-show delete is handled by the series event; a single episode goes to Badger on its own (INTG-DEL-01).
                var showFolderGone = StrmRef.TryGetShowFolder(ShowFolderOf(path), out _) && !Directory.Exists(ShowFolderOf(path));
                if (!showFolderGone)
                {
                    await DeleteEpisodeAsync(reference.MediaId, reference.EpisodeId, item.Name).ConfigureAwait(false);
                }

                return;
            }

            await DeleteMediaAsync(reference.MediaId, item.Name).ConfigureAwait(false);
            return;
        }

        if (item is Series && StrmRef.TryGetShowFolder(path, out var showId) && !Directory.Exists(path))
        {
            await DeleteMediaAsync(showId, item.Name).ConfigureAwait(false);
        }
    }

    private static string ShowFolderOf(string episodePath)
    {
        var seasonFolder = Path.GetDirectoryName(episodePath);
        return (seasonFolder is null ? null : Path.GetDirectoryName(seasonFolder)) ?? string.Empty;
    }

    private async Task DeleteMediaAsync(string mediaId, string name)
    {
        try
        {
            await _client.DeleteMediaAsync(mediaId, CancellationToken.None).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger deleted {Name} ({Media}) from SpaceBadger after a Jellyfin delete (INTG-DEL-01)", name, mediaId);
            await LogActivityAsync("Badger media deleted", $"'{name}' was deleted in Jellyfin and permanently removed from Badger.", LogLevel.Information).ConfigureAwait(false);
        }
        catch (SbSidecarException ex) when (ex.StatusCode == 404)
        {
            _logger.LogInformation("SpaceBadger media {Media} was already gone", mediaId);
        }
    }

    private async Task DeleteEpisodeAsync(string mediaId, string episodeId, string name)
    {
        try
        {
            var result = await _client.DeleteEpisodeAsync(mediaId, episodeId, CancellationToken.None).ConfigureAwait(false);
            _logger.LogInformation("SpaceBadger deleted episode {Name} ({Media}/{Episode}) from SpaceBadger after a Jellyfin delete (INTG-DEL-01), file removed={Deleted}", name, mediaId, episodeId, result.DeletedFile);
            await LogActivityAsync("Badger episode deleted", $"'{name}' was deleted in Jellyfin and permanently removed from Badger.", LogLevel.Information).ConfigureAwait(false);
        }
        catch (SbSidecarException ex) when (ex.StatusCode == 404)
        {
            _logger.LogInformation("SpaceBadger episode {Media}/{Episode} was already gone", mediaId, episodeId);
        }
    }

    private async Task LogActivityAsync(string name, string overview, LogLevel severity) =>
        await _activity.CreateAsync(new ActivityLog(name, "SpaceBadger", Guid.Empty) { ShortOverview = overview, LogSeverity = severity }).ConfigureAwait(false);
}
