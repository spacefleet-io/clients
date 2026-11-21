using Jellyfin.Plugin.SpaceBadger.Playback;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Sync;

/// <summary>
/// Keeps the generated library and the owner's resume/watched state in step with Badger: waits on the service's
/// change feed, regenerates files, makes sure the Jellyfin libraries exist and pushes Badger's resume position
/// and watched state into the owner's user data (INTG-SYNC-01: Badger is the source of truth).
/// </summary>
public sealed class LibrarySynchronizer : IHostedService, IDisposable
{
    private readonly SidecarClient _client;
    private readonly LibraryWriter _writer;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserDataManager _userData;
    private readonly IActivityManager _activity;
    private readonly OwnerService _owner;
    private readonly ILogger<LibrarySynchronizer> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private string _lastAccessState = "unknown";
    private string? _lastProfileNeeded;
    private bool _updateRequiredLogged;
    private bool _signedOutHandled;

    public LibrarySynchronizer(
        SidecarClient client,
        LibraryWriter writer,
        ILibraryManager libraryManager,
        IUserDataManager userData,
        IActivityManager activity,
        OwnerService owner,
        ILogger<LibrarySynchronizer> logger)
    {
        _client = client;
        _writer = writer;
        _libraryManager = libraryManager;
        _userData = userData;
        _activity = activity;
        _owner = owner;
        _logger = logger;
    }

    /// <summary>Gets the last status the service reported.</summary>
    public SbStatus? LastStatus { get; private set; }

    public string? LastSyncError { get; private set; }

    public DateTime? LastSyncAt { get; private set; }

    public int LastChangedFiles { get; private set; }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
        _libraryManager.ItemAdded += OnItemAdded;
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _libraryManager.ItemAdded -= OnItemAdded;
        _cts?.Cancel();
        if (_loop is not null)
        {
            try
            {
                await _loop.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
            {
                _logger.LogWarning("SpaceBadger sync loop did not stop in time");
            }
        }
    }

    public void Dispose()
    {
        _cts?.Dispose();
        _gate.Dispose();
    }

    /// <summary>Runs one full sync now (scheduled task / admin button).</summary>
    public async Task SyncNowAsync(CancellationToken ct)
    {
        var status = await _client.GetStatusAsync(ct).ConfigureAwait(false);
        await HandleStatusAsync(status, ct).ConfigureAwait(false);
        if (status.State != "ok")
        {
            throw new InvalidOperationException($"Badger service is not ready (state {status.State}{(status.LastError is null ? string.Empty : ": " + status.LastError)})");
        }

        await SyncOnceAsync(ct).ConfigureAwait(false);
    }

    private async Task RunAsync(CancellationToken ct)
    {
        long seq = -1;
        var needSync = true;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var plugin = Plugin.Instance;
                if (plugin is null || !plugin.Configuration.Enabled)
                {
                    await Task.Delay(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
                    continue;
                }

                var status = await _client.GetStatusAsync(ct).ConfigureAwait(false);
                await HandleStatusAsync(status, ct).ConfigureAwait(false);
                if (status.State != "ok")
                {
                    seq = -1;
                    needSync = true;
                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                    continue;
                }

                if (seq < 0)
                {
                    seq = (await _client.WaitChangesAsync(-1, 0, ct).ConfigureAwait(false)).Version;
                }

                if (needSync)
                {
                    await SyncOnceAsync(ct).ConfigureAwait(false);
                    needSync = false;
                }

                var changes = await _client.WaitChangesAsync(seq, 25, ct).ConfigureAwait(false);
                if (changes.Changed)
                {
                    _logger.LogInformation("SpaceBadger library changed (feed {Old} -> {New}); syncing", seq, changes.Version);
                    seq = changes.Version;
                    needSync = true;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                LastSyncError = ex.Message;
                _logger.LogWarning(ex, "SpaceBadger sync loop error; retrying");
                seq = -1;
                needSync = true;
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private async Task HandleStatusAsync(SbStatus status, CancellationToken ct)
    {
        LastStatus = status;
        if (status.State == "signed_out")
        {
            if (!_signedOutHandled)
            {
                await RemoveGeneratedLibraryAsync(status.SignedOutReason).ConfigureAwait(false);
                _signedOutHandled = true;
            }
        }
        else
        {
            _signedOutHandled = false;
        }

        if (status.AccessState == "unpaid" && _lastAccessState != "unpaid")
        {
            _logger.LogWarning("SpaceBadger subscription is unpaid; playback is blocked and media will be wiped on {WipeAt}", status.WipeAt);
            await _activity.CreateAsync(new ActivityLog(
                "Badger subscription unpaid",
                "SpaceBadgerSubscription",
                Guid.Empty)
            {
                LogSeverity = LogLevel.Warning,
                ShortOverview = $"Playback is paused. Media is removed on {(status.WipeAt is null ? "the wipe date" : WipeDate.Format(status.WipeAt))} unless the subscription is paid.",
            }).ConfigureAwait(false);
        }
        else if (status.AccessState != "unpaid" && _lastAccessState == "unpaid")
        {
            _logger.LogInformation("SpaceBadger subscription is active again ({State})", status.AccessState);
        }

        _lastAccessState = status.AccessState;

        // INTG-PROF-01: told once, on the transition; the settings page asks for the pick. Nothing syncs meanwhile (state needs_profile).
        if (status.ProfileNeeded is not null && status.ProfileNeeded != _lastProfileNeeded)
        {
            var deleted = status.ProfileNeeded == "deleted";
            _logger.LogWarning("SpaceBadger follows no profile ({Reason}, was {ProfileId}); viewing state is paused until one is picked in the plugin settings", status.ProfileNeeded, status.Profile?.Id);
            await _activity.CreateAsync(new ActivityLog(
                deleted ? "Badger profile deleted" : "Badger profile not picked",
                "SpaceBadgerProfile",
                Guid.Empty)
            {
                LogSeverity = LogLevel.Warning,
                ShortOverview = deleted
                    ? $"The Badger profile {status.Profile?.Name ?? "this server followed"} was deleted. Resume positions and watched marks stop syncing until you pick a profile in the Badger plugin settings."
                    : "This Badger account has several profiles. Pick the one this server follows in the Badger plugin settings; nothing syncs until then.",
            }).ConfigureAwait(false);
        }

        _lastProfileNeeded = status.ProfileNeeded;
        ct.ThrowIfCancellationRequested();

        // REL-CD-29 / LIB-FMT-13: the sidecar stopped with nothing applied; told once per sidecar process, the settings page keeps showing it.
        if (status.UpdateRequired is { } update && !_updateRequiredLogged)
        {
            _logger.LogWarning("SpaceBadger update required ({Reason}, minimum {MinVersion}): {Message}", update.Reason, update.MinVersion ?? "unknown", update.Message);
            await _activity.CreateAsync(new ActivityLog(
                "Badger plugin update required",
                "SpaceBadgerUpdate",
                Guid.Empty)
            {
                LogSeverity = LogLevel.Warning,
                ShortOverview = update.Message,
            }).ConfigureAwait(false);
        }

        _updateRequiredLogged = status.UpdateRequired is not null;
    }

    /// <summary>The device was signed out (revoked, 401 or user): nothing of the library may stay (ACCT-DEV-01, PRIV-KEY-05).</summary>
    public async Task RemoveGeneratedLibraryAsync(string? reason)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var plugin = Plugin.Instance!;
            _logger.LogWarning("SpaceBadger is signed out ({Reason}); removing the generated library and the Jellyfin libraries that point at it", reason ?? "unknown");
            _writer.RemoveAll(plugin.LibraryRoot, Path.Combine(plugin.DataDirectory, "index.json"));
            foreach (var name in new[] { plugin.Configuration.MoviesLibraryName, plugin.Configuration.ShowsLibraryName })
            {
                if (_libraryManager.GetVirtualFolders().Any(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)))
                {
                    await _libraryManager.RemoveVirtualFolder(name, refreshLibrary: true).ConfigureAwait(false);
                    _logger.LogInformation("SpaceBadger removed the Jellyfin library {Name}", name);
                }
            }

            await _activity.CreateAsync(new ActivityLog("Badger signed out", "SpaceBadgerSignedOut", Guid.Empty)
            {
                LogSeverity = LogLevel.Warning,
                ShortOverview = "This server was signed out of Badger (" + (reason ?? "unknown") + "). The library was removed. Pair again from the Badger settings page to bring it back.",
            }).ConfigureAwait(false);
            LastSyncError = null;
            LastChangedFiles = 0;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task SyncOnceAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var plugin = Plugin.Instance!;
            var library = await _client.GetLibraryAsync(ct).ConfigureAwait(false);
            var root = plugin.LibraryRoot;
            var started = DateTime.UtcNow;
            var changed = await _writer.SyncAsync(library, root, Path.Combine(plugin.DataDirectory, "index.json"), ct).ConfigureAwait(false);
            await EnsureLibrariesAsync(root, plugin.Configuration).ConfigureAwait(false);
            LastChangedFiles = changed;
            LastSyncAt = DateTime.UtcNow;
            LastSyncError = null;
            _logger.LogInformation(
                "SpaceBadger sync: library v{Version}, {Movies} movies, {Shows} shows, {Changed} files changed in {Ms} ms",
                library.Version,
                library.Movies.Count,
                library.Shows.Count,
                changed,
                (DateTime.UtcNow - started).TotalMilliseconds);
            if (changed > 0)
            {
                _libraryManager.QueueLibraryScan();
            }

            ApplyResumeForAll(library);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task EnsureLibrariesAsync(string root, Configuration.PluginConfiguration config)
    {
        var folders = _libraryManager.GetVirtualFolders();
        await EnsureLibraryAsync(folders, config.MoviesLibraryName, LibraryWriter.MoviesDir(root), CollectionTypeOptions.movies).ConfigureAwait(false);
        await EnsureLibraryAsync(folders, config.ShowsLibraryName, LibraryWriter.ShowsDir(root), CollectionTypeOptions.tvshows).ConfigureAwait(false);
    }

    private async Task EnsureLibraryAsync(List<VirtualFolderInfo> folders, string name, string path, CollectionTypeOptions type)
    {
        var existing = folders.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));
        if (existing is not null)
        {
            if (existing.Locations.Any(l => string.Equals(l, path, StringComparison.Ordinal)))
            {
                return;
            }

            // The library folder moved (new default location or a changed setting): repoint the Jellyfin library.
            _logger.LogInformation("SpaceBadger library {Name} pointed at {Old}; recreating it at {Path}", name, string.Join(", ", existing.Locations), path);
            await _libraryManager.RemoveVirtualFolder(name, refreshLibrary: false).ConfigureAwait(false);
        }

        _logger.LogInformation("Creating Jellyfin library {Name} at {Path}", name, path);
        var options = new LibraryOptions
        {
            PathInfos = new[] { new MediaPathInfo(path) },
            EnableRealtimeMonitor = true,
            SaveLocalMetadata = false,
        };
        await _libraryManager.AddVirtualFolder(name, type, options, refreshLibrary: true).ConfigureAwait(false);
    }

    private void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        if (e.Item.Path is { } path && path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase) && IsInLibrary(path))
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    var library = await _client.GetLibraryAsync(CancellationToken.None).ConfigureAwait(false);
                    ApplyResume(e.Item, library);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "SpaceBadger could not apply resume to new item {Path}", path);
                }
            });
        }
    }

    private static bool IsInLibrary(string path)
    {
        var root = Plugin.Instance?.LibraryRoot;
        return !string.IsNullOrEmpty(root) && path.StartsWith(root, StringComparison.Ordinal);
    }

    private void ApplyResumeForAll(SbLibrary library)
    {
        var plugin = Plugin.Instance!;
        var root = plugin.LibraryRoot;
        foreach (var path in EnumerateStrm(root))
        {
            if (_libraryManager.FindByPath(path, false) is { } item)
            {
                ApplyResume(item, library);
            }
        }
    }

    private static IEnumerable<string> EnumerateStrm(string root) =>
        Directory.Exists(root) ? Directory.EnumerateFiles(root, "*.strm", SearchOption.AllDirectories) : Enumerable.Empty<string>();

    private void ApplyResume(BaseItem scanned, SbLibrary library)
    {
        // Jellyfin keeps the user data of the item instance it serves (item.UserData) and refreshes it only on the instance
        // that is saved. A path lookup returns a fresh copy, so saving through it left the item page (GET /Items/<id>) showing
        // the old position while the database and the resume lists were right. Always save through the served instance.
        var item = _libraryManager.GetItemById(scanned.Id) ?? scanned;
        var owner = _owner.GetOwner();
        if (owner is null || item.Path is null || !StrmRef.TryParse(item.Path, out var reference))
        {
            return;
        }

        if (!TryResolveResume(library, reference, out var resume))
        {
            return;
        }

        var data = _userData.GetUserData(owner, item);
        if (data is null)
        {
            return;
        }

        // INTG-PROF-01: no resume = the followed profile has not started it (never the main profile's progress), so the
        // owner's Jellyfin user is reset too; after a profile change the previous profile's marks must not stay.
        var watched = resume?.Watched ?? false;
        var wantedTicks = watched ? 0 : (long)((resume?.PositionSeconds ?? 0) * TimeSpan.TicksPerSecond);
        if (data.Played == watched && data.PlaybackPositionTicks == wantedTicks)
        {
            return;
        }

        _logger.LogInformation(
            "SpaceBadger resume -> Jellyfin owner {User}: {Item} watched={Watched} position={Position}s",
            owner.Username,
            item.Name,
            watched,
            resume?.PositionSeconds ?? 0);
        data.Played = watched;
        data.PlaybackPositionTicks = wantedTicks;
        if (watched && data.PlayCount < 1)
        {
            data.PlayCount = 1;
        }

        // Import: the playback forwarder ignores this reason, so Badger's own state is never echoed back.
        _userData.SaveUserData(owner, item, data, UserDataSaveReason.Import, CancellationToken.None);
    }

    /// <summary>False when the item is not in the library; true with a null resume when the followed profile has not started it.</summary>
    private static bool TryResolveResume(SbLibrary library, StrmRef reference, out SbResume? resume)
    {
        resume = null;
        if (reference.EpisodeId is null)
        {
            var movie = library.Movies.FirstOrDefault(m => m.Id == reference.MediaId);
            resume = movie?.Resume;
            return movie is not null;
        }

        var episode = library.Shows.FirstOrDefault(s => s.Id == reference.MediaId)?
            .Seasons.SelectMany(s => s.Episodes).FirstOrDefault(e => e.Id == reference.EpisodeId);
        resume = episode?.Resume;
        return episode is not null;
    }
}
