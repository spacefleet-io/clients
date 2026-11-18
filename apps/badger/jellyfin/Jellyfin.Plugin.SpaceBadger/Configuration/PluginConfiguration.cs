using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SpaceBadger.Configuration;

/// <summary>
/// Persisted plugin settings. Secrets are NOT stored here: the Badger password is sent once to the local
/// service and never kept; the library key lives in a private 0600 file (PRIV-KEY-04).
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>The account API every run outside dev mode talks to (ACCT-AUTH-09).</summary>
    public const string ProductionApiUrl = "https://api.spacefleet.io";

    /// <summary>
    /// Gets a value indicating whether this Jellyfin runs in dev mode: HEADLESS_DEV_TICKET_KEY is exactly <c>1</c> in its
    /// environment, the switch that also makes the service trust the dev ticket key (META-ANON-06). Only then does
    /// <see cref="ApiUrl"/> count and the dashboard show it (ACCT-AUTH-09).
    /// </summary>
    public static bool DevMode => Environment.GetEnvironmentVariable("HEADLESS_DEV_TICKET_KEY")?.Trim() == "1";

    /// <summary>Gets or sets the Badger API base URL. Used in dev mode only (<see cref="EffectiveApiUrl"/>).</summary>
    public string ApiUrl { get; set; } = ProductionApiUrl;

    /// <summary>Gets or sets the Jellyfin user whose progress, watched state and track choices sync back (INTG-JF-01). Empty = first administrator.</summary>
    public Guid OwnerUserId { get; set; } = Guid.Empty;

    /// <summary>Gets or sets an explicit path to the badger integration binary. Empty = the plugin downloads the one for this server.</summary>
    public string SidecarPath { get; set; } = string.Empty;

    /// <summary>Gets or sets where the service binary is downloaded from (a folder holding one sub-folder per plugin version). Empty = the Badger server.</summary>
    public string SidecarDownloadUrl { get; set; } = string.Empty;

    /// <summary>Gets or sets the metadata service URL the service looks up pictures at with anonymous tickets (META-RELAY-01). Empty = the service's built-in default.</summary>
    public string MetadataUrl { get; set; } = string.Empty;

    /// <summary>Gets or sets the localhost port of the decrypting service (never exposed, INTG-JF-03).</summary>
    public int SidecarPort { get; set; } = 8790;

    /// <summary>Gets or sets the folder the shortcut library is generated in. Empty = a folder next to (not inside) the Jellyfin data directory, so Jellyfin keeps the quality versions.</summary>
    public string LibraryRoot { get; set; } = string.Empty;

    /// <summary>Gets or sets the name of the Jellyfin movie library.</summary>
    public string MoviesLibraryName { get; set; } = "Badger Movies";

    /// <summary>Gets or sets the name of the Jellyfin show library.</summary>
    public string ShowsLibraryName { get; set; } = "Badger Shows";

    /// <summary>Gets or sets a value indicating whether the plugin runs the service and syncs.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets the API the plugin and its service talk to: <see cref="ApiUrl"/> in dev mode, else production; a stored value from a dev install is ignored (ACCT-AUTH-09).</summary>
    /// <returns>The API base URL without a trailing slash.</returns>
    public string EffectiveApiUrl() => (DevMode && !string.IsNullOrWhiteSpace(ApiUrl) ? ApiUrl : ProductionApiUrl).Trim().TrimEnd('/');
}
