using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.SpaceBadger.Sync;

/// <summary>Dashboard task "Sync Badger library" (also runs on a schedule as a safety net; real-time sync is the change feed).</summary>
public sealed class SyncScheduledTask : IScheduledTask
{
    private readonly LibrarySynchronizer _synchronizer;

    public SyncScheduledTask(LibrarySynchronizer synchronizer)
    {
        _synchronizer = synchronizer;
    }

    public string Name => "Sync Badger library";

    public string Key => "SpaceBadgerSync";

    public string Description => "Regenerates the Badger shortcut library and pulls resume positions from Badger.";

    public string Category => "Badger";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);
        await _synchronizer.SyncNowAsync(cancellationToken).ConfigureAwait(false);
        progress.Report(100);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(6).Ticks,
        };
    }
}
