using Jellyfin.Plugin.SpaceBadger.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SpaceBadger;

/// <summary>The Badger plugin: a thin layer over the local decrypting service (INTG-JF-04).</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        PluginDirectory = Path.GetDirectoryName(GetType().Assembly.Location) ?? applicationPaths.PluginsPath;
        DataDirectory = Path.Combine(applicationPaths.DataPath, "spacebadger");
        DefaultLibraryRoot = Path.Combine(applicationPaths.ProgramDataPath, "spacebadger-library");
    }

    /// <inheritdoc />
    public override string Name => "Badger";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("5d6b2f6e-3a5c-4b8e-9d71-0c7a1f4e9b21");

    /// <inheritdoc />
    public override string Description => "Plays your encrypted Badger library in Jellyfin.";

    public static Plugin? Instance { get; private set; }

    /// <summary>Gets the folder the plugin assembly (and the bundled service binary) lives in.</summary>
    public string PluginDirectory { get; }

    /// <summary>Gets the plugin's private data folder (service state, key file, generated library).</summary>
    public string DataDirectory { get; }

    /// <summary>
    /// Gets the default folder for the shortcut library. It is deliberately NOT inside Jellyfin's data folder:
    /// Jellyfin 12 treats everything under it as its own internals and silently drops the alternate versions
    /// (the 1080p/360p grouping, INTG-QUAL-01) of media found there.
    /// </summary>
    public string DefaultLibraryRoot { get; }

    /// <summary>Gets the folder the shortcut library is generated in.</summary>
    public string LibraryRoot =>
        string.IsNullOrWhiteSpace(Configuration.LibraryRoot) ? DefaultLibraryRoot : Configuration.LibraryRoot;

    /// <summary>Gets the service state folder (login token, library cache).</summary>
    public string StateDirectory => Path.Combine(DataDirectory, "state");

    /// <summary>Gets the private library key file (0600).</summary>
    public string KeyFilePath => Path.Combine(DataDirectory, "library.key");

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            // Page id used in the settings URL, not shown as the product name: the page's own title and heading say Badger.
            Name = "SpaceBadger",
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
        };

        // Vendored MIT QR generator (see qrcode.LICENSE.txt); the settings page draws the pairing QR with it.
        yield return new PluginPageInfo
        {
            Name = "spacebadger-qrcode.js",
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.qrcode.js",
        };
    }
}
