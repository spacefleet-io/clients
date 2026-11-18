using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.SpaceBadger.Tests;

/// <summary>
/// The plugin is called Badger wherever Jellyfin shows its name (plugin list, catalog, settings page, dashboard task,
/// activity log, playback messages). SpaceBadger stays only in identifiers nobody reads as the product name: the
/// namespace/assembly, the API route, element ids, settings-page id, activity types, user-data keys and log prefixes.
/// </summary>
public sealed partial class AppNameTests
{
    private readonly ITestOutputHelper _output;

    public AppNameTests(ITestOutputHelper output)
    {
        _output = output;
    }

    // "SpaceBadger" as a word on its own: not inside an identifier (SpaceBadgerConfigPage), a dotted name
    // (Jellyfin.Plugin.SpaceBadger, SpaceBadger.TrackPreferences) or an API path (SpaceBadger/Profiles).
    [GeneratedRegex(@"(?<![\w.\[\-#])SpaceBadger(?![\w/\-\]]|\.[A-Z])")]
    private static partial Regex ProductName();

    // Developer-facing lines that keep the old name on purpose.
    private static readonly string[] KeptLineMarkers =
    {
        "_logger.",                              // log lines: SpaceBadger stays the grep-able log prefix
        "[Route(\"SpaceBadger\")]",              // API route, called by the settings page
        "Name = \"SpaceBadger\",",              // settings-page id (configurationpage?name=SpaceBadger)
        "new ActivityLog(name, \"SpaceBadger\"", // activity type id
    };

    private static string PluginSource([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "Jellyfin.Plugin.SpaceBadger"));

    // @req PLAT-SUITE-02[badger-jellyfin]
    [Fact]
    public void CatalogMetadataSaysBadger()
    {
        using var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(PluginSource(), "meta.json")));
        var root = meta.RootElement;
        foreach (var key in new[] { "name", "description", "overview", "owner" })
        {
            var value = root.GetProperty(key).GetString()!;
            _output.WriteLine($"meta.json {key}: {value}");
            Assert.False(ProductName().IsMatch(value), $"meta.json {key} still says SpaceBadger: {value}");
        }

        Assert.Equal("Badger", root.GetProperty("name").GetString());
        Assert.Equal("Badger", root.GetProperty("owner").GetString());
    }

    // @req PLAT-SUITE-02[badger-jellyfin]
    [Fact]
    public void PluginNameIsBadgerAndGuidIsUnchanged()
    {
        var plugin = File.ReadAllText(Path.Combine(PluginSource(), "Plugin.cs"));
        Assert.Contains("public override string Name => \"Badger\";", plugin, StringComparison.Ordinal);

        using var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(PluginSource(), "meta.json")));
        var guid = meta.RootElement.GetProperty("guid").GetString()!;
        _output.WriteLine($"plugin guid {guid}");
        Assert.Contains(guid, plugin, StringComparison.OrdinalIgnoreCase);
    }

    // @req PLAT-SUITE-02[badger-jellyfin]
    [Fact]
    public void SettingsPageSaysBadger()
    {
        var path = Path.Combine(PluginSource(), "Configuration", "configPage.html");
        var hits = Hits(path, File.ReadAllLines(path), keep: Array.Empty<string>());
        _output.WriteLine($"configPage.html: {hits.Count} product-name hits");
        Assert.Empty(hits);
    }

    // @req PLAT-SUITE-02[badger-jellyfin]
    [Fact]
    public void PluginStringsSayBadger()
    {
        var files = Directory.GetFiles(PluginSource(), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .ToArray();
        Assert.NotEmpty(files);
        var hits = files.SelectMany(f => Hits(f, File.ReadAllLines(f), KeptLineMarkers)).ToList();
        _output.WriteLine($"{files.Length} C# files checked; hits: {string.Join(" | ", hits)}");
        Assert.Empty(hits);
    }

    [Fact]
    public void PatternKeepsIdentifiersAndCatchesNames()
    {
        foreach (var kept in new[] { "namespace Jellyfin.Plugin.SpaceBadger.Sync;", "id=\"SpaceBadgerConfigPage\"", "ApiClient.getUrl('SpaceBadger/' + path)", "\"SpaceBadger.TrackPreferences\"", "https://spacebadger.io" })
        {
            Assert.False(ProductName().IsMatch(kept), kept);
        }

        foreach (var caught in new[] { "<h1>SpaceBadger</h1>", "Name => \"SpaceBadger\";", "toast('SpaceBadger sign-in failed.')", "from SpaceBadger." })
        {
            Assert.True(ProductName().IsMatch(caught), caught);
        }
    }

    private static List<string> Hits(string path, string[] lines, string[] keep)
    {
        var hits = new List<string>();
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (keep.Any(k => line.Contains(k, StringComparison.Ordinal)))
            {
                continue;
            }

            // Continuation line of a multi-line log template ("SpaceBadger progress {Phase}: ...").
            if (Regex.IsMatch(line, "^\\s*\\$?\"SpaceBadger [^\"]*\\{"))
            {
                continue;
            }

            if (ProductName().IsMatch(line))
            {
                hits.Add($"{Path.GetFileName(path)}:{i + 1}: {line.Trim()}");
            }
        }

        return hits;
    }
}
