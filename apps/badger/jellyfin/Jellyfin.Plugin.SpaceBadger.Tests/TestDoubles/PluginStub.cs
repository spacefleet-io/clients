// Stand-ins for the two host-bound types the linked library writer and sidecar client name. The real `Plugin` derives
// from Jellyfin's BasePlugin and `TrackPreferences` uses Jellyfin enums; the tests only need the sidecar port and the type.
namespace Jellyfin.Plugin.SpaceBadger
{
    public sealed class Plugin
    {
        public static Plugin? Instance { get; set; }

        public StubConfiguration Configuration { get; } = new();
    }

    public sealed class StubConfiguration
    {
        public int SidecarPort { get; set; } = 8790;
    }
}

namespace Jellyfin.Plugin.SpaceBadger.Playback
{
    public sealed class TrackPreferences
    {
    }

    public sealed class SubtitleValue
    {
        public bool Off { get; init; }

        public object? Choice { get; init; }
    }
}
