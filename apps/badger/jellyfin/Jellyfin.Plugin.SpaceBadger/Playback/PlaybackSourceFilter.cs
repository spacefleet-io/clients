using Jellyfin.Data.Enums;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Plugin.SpaceBadger.Sync;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>
/// INTG-JF-03: Jellyfin does the streaming. A plain <c>.strm</c> makes Jellyfin advertise the shortcut URL (the private
/// 127.0.0.1 address of the decrypting service) as a direct-play source, so apps would try to play from it.
/// For Badger items this filter (1) forces direct play off in PlaybackInfo so Jellyfin builds its own
/// stream URL (direct stream = repackaging only when the app supports the formats, transcoding otherwise)
/// and (2) never lets the private address leave the server in media source descriptions.
/// </summary>
public sealed class PlaybackSourceFilter : IAsyncActionFilter, IAsyncResultFilter
{
    private const string RedactedPath = "Badger";
    private const string BitrateCapKey = "SpaceBadger.MaxStreamingBitrate";
    private const string TrackPrefsKey = "SpaceBadger.TrackPreferences";

    private readonly ILibraryManager _libraryManager;
    private readonly IMediaSourceManager _mediaSources;
    private readonly UnpaidNotifier _notifier;
    private readonly OwnerService _owner;
    private readonly SidecarClient _client;
    private readonly ILogger<PlaybackSourceFilter> _logger;

    public PlaybackSourceFilter(
        ILibraryManager libraryManager,
        IMediaSourceManager mediaSources,
        UnpaidNotifier notifier,
        OwnerService owner,
        SidecarClient client,
        ILogger<PlaybackSourceFilter> logger)
    {
        _libraryManager = libraryManager;
        _mediaSources = mediaSources;
        _notifier = notifier;
        _owner = owner;
        _client = client;
        _logger = logger;
    }

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (context.ActionDescriptor is ControllerActionDescriptor { ControllerName: "MediaInfo" } descriptor
            && descriptor.ActionName is "GetPostedPlaybackInfo" or "GetPlaybackInfo"
            && context.ActionArguments.TryGetValue("itemId", out var rawId)
            && rawId is Guid itemId
            && _libraryManager.GetItemById(itemId) is { } item
            && item.Path is { } path
            && IsOurs(path))
        {
            if (context.ActionArguments.ContainsKey("enableDirectPlay"))
            {
                context.ActionArguments["enableDirectPlay"] = false;
            }

            // PlaybackInfoDto lives in the Jellyfin.Api assembly, which plugins do not reference: set it by reflection.
            if (context.ActionArguments.TryGetValue("playbackInfoDto", out var dto) && dto is not null)
            {
                var property = dto.GetType().GetProperty("EnableDirectPlay");
                if (property is { CanWrite: true })
                {
                    property.SetValue(dto, false);
                }
            }

            var cap = ReadBitrateCap(context.ActionArguments);
            if (cap is > 0)
            {
                context.HttpContext.Items[BitrateCapKey] = cap.Value;
            }

            _logger.LogInformation("SpaceBadger PlaybackInfo for {Item}: direct play disabled so Jellyfin streams it (INTG-JF-03)", item.Name);
            if (Guid.TryParse(context.HttpContext.User.FindFirst("Jellyfin-UserId")?.Value, out var userId))
            {
                await _notifier.CheckAndNotifyAsync(userId, context.HttpContext.RequestAborted).ConfigureAwait(false);
                await ApplyRememberedTracksToRequestAsync(context, item, userId).ConfigureAwait(false);
            }
        }

        await next().ConfigureAwait(false);
    }

    public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
    {
        if (context.Result is ObjectResult { Value: { } value })
        {
            Redact(value, context.HttpContext.Items.TryGetValue(BitrateCapKey, out var cap) && cap is long limit ? limit : null);
            await ApplyRememberedTracksToResponseAsync(context, value).ConfigureAwait(false);
        }

        await next().ConfigureAwait(false);
    }

    /// <summary>The owner's remembered audio/subtitle choice for the movie or show, or null (other users, no choice, service down).</summary>
    private async Task<TrackPreferences?> LoadRememberedTracksAsync(Guid userId, MediaBrowser.Controller.Entities.BaseItem item, CancellationToken ct)
    {
        if (!_owner.IsOwner(userId) || item.Path is not { } path || !StrmRef.TryParse(path, out var reference))
        {
            return null;
        }

        try
        {
            var prefs = await _client.GetTracksAsync(reference.MediaId, ct).ConfigureAwait(false);
            _logger.LogInformation(
                "SpaceBadger remembered tracks for {Media}: audio={Audio} subtitle={Subtitle}",
                reference.MediaId,
                prefs.AudioLanguage ?? "none",
                prefs.Subtitle is null ? "none" : prefs.Subtitle.Off ? "off" : prefs.Subtitle.Choice!.Language);
            return prefs;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "SpaceBadger could not read the remembered audio/subtitle choice of {Media}", reference.MediaId);
            return null;
        }
    }

    /// <summary>
    /// PLAY-TRACK-04: starting a movie or episode uses the choice remembered for it (set in any Badger app) instead of
    /// the server's own default, unless the app asked for a specific track.
    /// </summary>
    private async Task ApplyRememberedTracksToRequestAsync(ActionExecutingContext context, MediaBrowser.Controller.Entities.BaseItem item, Guid userId)
    {
        var prefs = await LoadRememberedTracksAsync(userId, item, context.HttpContext.RequestAborted).ConfigureAwait(false);
        if (prefs is null)
        {
            return;
        }

        var source = item;
        if (context.ActionArguments.TryGetValue("playbackInfoDto", out var dtoForSource) && dtoForSource is not null
            && dtoForSource.GetType().GetProperty("MediaSourceId")?.GetValue(dtoForSource) is string requested
            && Guid.TryParse(requested, out var sourceItemId)
            && _libraryManager.GetItemById(sourceItemId) is { } chosenSource)
        {
            source = chosenSource;
        }

        var streams = _mediaSources.GetMediaStreams(source.Id);
        var audio = TrackResolver.ResolveAudio(prefs, streams)?.Index;
        var subtitle = TrackResolver.ResolveSubtitleIndex(prefs, streams);
        var askedAudio = SetWhenUnset(context, "audioStreamIndex", "AudioStreamIndex", audio);
        var askedSubtitle = SetWhenUnset(context, "subtitleStreamIndex", "SubtitleStreamIndex", subtitle);
        context.HttpContext.Items[TrackPrefsKey] = new AppliedTracks(prefs, askedAudio is not null, askedSubtitle is not null);
        _logger.LogInformation(
            "SpaceBadger PlaybackInfo for {Item}: remembered choice is audio stream {Audio}, subtitle stream {Subtitle}; the app asked for audio {AskedAudio}, subtitle {AskedSubtitle} (an explicit ask wins)",
            item.Name,
            audio?.ToString() ?? "default",
            subtitle?.ToString() ?? "default",
            askedAudio?.ToString() ?? "nothing",
            askedSubtitle?.ToString() ?? "nothing");
    }

    /// <summary>Fills the track index only when the app asked for none (neither in the query nor in the posted body); returns what the app asked for.</summary>
    private static int? SetWhenUnset(ActionExecutingContext context, string argument, string dtoProperty, int? value)
    {
        context.ActionArguments.TryGetValue("playbackInfoDto", out var dto);
        var property = dto?.GetType().GetProperty(dtoProperty);
        var asked = (context.ActionArguments.TryGetValue(argument, out var fromQuery) ? fromQuery as int? : null)
            ?? property?.GetValue(dto) as int?;
        if (asked is not null || value is null)
        {
            return asked;
        }

        if (property is { CanWrite: true })
        {
            property.SetValue(dto, value);
        }
        else if (context.ActionArguments.ContainsKey(argument))
        {
            context.ActionArguments[argument] = value;
        }

        return null;
    }

    /// <summary>The default tracks an app shows (details page pickers, PlaybackInfo sources) are the remembered ones.</summary>
    private async Task ApplyRememberedTracksToResponseAsync(ResultExecutingContext context, object value)
    {
        if (!Guid.TryParse(context.HttpContext.User.FindFirst("Jellyfin-UserId")?.Value, out var userId) || !_owner.IsOwner(userId))
        {
            return;
        }

        switch (value)
        {
            case PlaybackInfoResponse response when context.HttpContext.Items.TryGetValue(TrackPrefsKey, out var stored) && stored is AppliedTracks applied:
                ApplyDefaults(response.MediaSources, applied.Prefs, !applied.AskedAudio, !applied.AskedSubtitle);
                break;
            case BaseItemDto { MediaSources.Length: > 0 } dto when dto.Id != Guid.Empty
                && _libraryManager.GetItemById(dto.Id) is { } item
                && item.Path is { } path
                && IsOurs(path):
                var remembered = await LoadRememberedTracksAsync(userId, item, context.HttpContext.RequestAborted).ConfigureAwait(false);
                if (remembered is not null)
                {
                    ApplyDefaults(dto.MediaSources, remembered, true, true);
                }

                break;
        }
    }

    /// <summary>What the request filter decided, so the response keeps an explicit ask of the app.</summary>
    private sealed record AppliedTracks(TrackPreferences Prefs, bool AskedAudio, bool AskedSubtitle);

    private static void ApplyDefaults(IReadOnlyList<MediaSourceInfo>? sources, TrackPreferences prefs, bool audio, bool subtitle)
    {
        if (sources is null)
        {
            return;
        }

        foreach (var source in sources.Where(s => s.MediaStreams is not null))
        {
            if (audio && TrackResolver.ResolveAudio(prefs, source.MediaStreams)?.Index is { } audioIndex)
            {
                source.DefaultAudioStreamIndex = audioIndex;
            }

            if (subtitle && TrackResolver.ResolveSubtitleIndex(prefs, source.MediaStreams) is { } subtitleIndex)
            {
                source.DefaultSubtitleStreamIndex = subtitleIndex;
            }
        }
    }

    private static bool IsOurs(string path)
    {
        var root = Plugin.Instance?.LibraryRoot;
        return !string.IsNullOrEmpty(root) && path.StartsWith(root, StringComparison.Ordinal);
    }

    private static bool IsPrivate(MediaSourceInfo source)
    {
        var port = Plugin.Instance?.Configuration.SidecarPort ?? 8790;
        return source.Path is { } path && path.StartsWith($"http://127.0.0.1:{port}/", StringComparison.Ordinal);
    }

    /// <summary>The bitrate ceiling the app asked for: the request's own cap, else the device profile's.</summary>
    private static long? ReadBitrateCap(IDictionary<string, object?> arguments)
    {
        long? cap = null;
        void Consider(long? candidate)
        {
            if (candidate is > 0 && (cap is null || candidate < cap))
            {
                cap = candidate;
            }
        }

        if (arguments.TryGetValue("maxStreamingBitrate", out var query) && query is int fromQuery)
        {
            Consider(fromQuery);
        }

        if (arguments.TryGetValue("playbackInfoDto", out var dto) && dto is not null)
        {
            Consider(ToLong(dto.GetType().GetProperty("MaxStreamingBitrate")?.GetValue(dto)));
            var profile = dto.GetType().GetProperty("DeviceProfile")?.GetValue(dto);
            Consider(ToLong(profile?.GetType().GetProperty("MaxStreamingBitrate")?.GetValue(profile)));
        }

        return cap;
    }

    private static long? ToLong(object? value) => value switch
    {
        int i => i,
        long l => l,
        _ => null,
    };

    private void Redact(object value, long? bitrateCap)
    {
        switch (value)
        {
            case PlaybackInfoResponse response:
                var originals = response.MediaSources.Where(IsPrivate).Where(s => StrmRef.IsDefaultUrl(s.Path)).Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
                RedactSources(response.MediaSources);
                response.MediaSources = OrderForBitrateCap(response.MediaSources, bitrateCap, originals);
                break;
            case BaseItemDto dto:
                RedactSources(dto.MediaSources);
                break;
            case QueryResult<BaseItemDto> page:
                foreach (var dto in page.Items)
                {
                    RedactSources(dto.MediaSources);
                }

                break;
            case IEnumerable<BaseItemDto> list:
                foreach (var dto in list)
                {
                    RedactSources(dto.MediaSources);
                }

                break;
        }
    }

    private void RedactSources(IReadOnlyList<MediaSourceInfo>? sources)
    {
        if (sources is null)
        {
            return;
        }

        foreach (var source in sources.Where(IsPrivate))
        {
            source.Path = RedactedPath;
            source.SupportsDirectPlay = false;
            ApplyQualityBitrate(source);
        }
    }

    /// <summary>
    /// INTG-QUAL-01: a shortcut has no file size, so Jellyfin derives a meaningless total bitrate (bytes of the
    /// 100-byte .strm over the runtime). Once the streams were probed, the sum of their real bitrates is the honest
    /// number: it is what lets apps and the cap logic tell the 1080p and 360p versions apart.
    /// </summary>
    private static void ApplyQualityBitrate(MediaSourceInfo source)
    {
        long total = 0;
        foreach (var stream in source.MediaStreams)
        {
            if (stream.Type is MediaStreamType.Video or MediaStreamType.Audio && stream.BitRate is > 0)
            {
                total += stream.BitRate.Value;
            }
        }

        if (total > 0 && total <= int.MaxValue)
        {
            source.Bitrate = (int)total;
        }
    }

    /// <summary>
    /// INTG-QUAL-01: when the app caps the streaming bitrate, the version that fits the cap (the best one that
    /// does) comes first and is what Jellyfin clients start with. Without a cap, the order is untouched: original first.
    /// </summary>
    private IReadOnlyList<MediaSourceInfo> OrderForBitrateCap(IReadOnlyList<MediaSourceInfo> sources, long? cap, HashSet<string> originals)
    {
        if (sources.Count < 2 || !sources.All(IsRedacted))
        {
            return sources;
        }

        // Without a cap the original quality is the default version (Jellyfin alone would pick by file name).
        // With a cap, the best version that fits goes first; when none fits, the smallest (Jellyfin transcodes it down).
        List<MediaSourceInfo> first;
        if (cap is > 0)
        {
            first = sources.Where(s => s.Bitrate is { } b && b <= cap).OrderByDescending(s => s.Bitrate).Take(1).ToList();
            if (first.Count == 0)
            {
                first = sources.OrderBy(s => s.Bitrate ?? int.MaxValue).Take(1).ToList();
            }
        }
        else
        {
            first = sources.Where(s => s.Id is not null && originals.Contains(s.Id)).Take(1).ToList();
        }

        if (first.Count == 0)
        {
            return sources;
        }

        var ordered = first.Concat(sources.Except(first)).ToList();
        _logger.LogInformation(
            "SpaceBadger PlaybackInfo: app cap {Cap} bit/s, offering {First} first ({Bitrate} bit/s) (INTG-QUAL-01)",
            cap?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none",
            ordered[0].Name,
            ordered[0].Bitrate);
        return ordered;
    }

    private static bool IsRedacted(MediaSourceInfo source) => source.Path == RedactedPath;
}
