using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>
/// The Badger identity of a generated shortcut file: the <c>.strm</c> holds
/// <c>http://127.0.0.1:&lt;port&gt;/integration/v1/media/&lt;mediaId&gt;[/&lt;episodeId&gt;]/&lt;quality&gt;/master.m3u8</c>.
/// Remembered per path so a file that was just deleted (INTG-DEL-01) can still be attributed.
/// </summary>
public sealed record StrmRef(string MediaId, string? EpisodeId, string QualityKey)
{
    private static readonly Regex Pattern = new(@"/integration/v1/media/(?<m>[^/\s]+)(?:/(?<e>[^/\s]+))?/(?<q>[^/\s]+)/master\.m3u8", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly ConcurrentDictionary<string, StrmRef> ByPath = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, string> ShowFolders = new(StringComparer.Ordinal);

    /// <summary>Records the identity of a freshly written shortcut file.</summary>
    public static void Remember(string path, string strmContent)
    {
        if (TryParseContent(strmContent, out var reference))
        {
            ByPath[path] = reference;
        }
    }

    private static readonly ConcurrentDictionary<string, bool> DefaultUrls = new(StringComparer.Ordinal);

    /// <summary>Records the shortcut URL of an original (default) version, refreshed by every sync.</summary>
    public static void RememberDefault(string url) => DefaultUrls[url.Trim()] = true;

    public static bool IsDefaultUrl(string? url) => url is not null && DefaultUrls.ContainsKey(url.Trim());

    /// <summary>Records which Badger show a series folder belongs to.</summary>
    public static void RememberShowFolder(string folder, string mediaId) => ShowFolders[folder] = mediaId;

    public static bool TryGetShowFolder(string folder, out string mediaId) => ShowFolders.TryGetValue(folder, out mediaId!);

    public static bool TryParse(string path, out StrmRef reference)
    {
        if (ByPath.TryGetValue(path, out reference!))
        {
            return true;
        }

        try
        {
            if (File.Exists(path) && TryParseContent(File.ReadAllText(path), out reference!))
            {
                ByPath[path] = reference;
                return true;
            }
        }
        catch (IOException)
        {
            // fall through: unreadable shortcut
        }

        reference = null!;
        return false;
    }

    public static bool TryParseContent(string content, out StrmRef reference)
    {
        var match = Pattern.Match(content);
        if (!match.Success)
        {
            reference = null!;
            return false;
        }

        reference = new StrmRef(
            Uri.UnescapeDataString(match.Groups["m"].Value),
            match.Groups["e"].Success ? Uri.UnescapeDataString(match.Groups["e"].Value) : null,
            Uri.UnescapeDataString(match.Groups["q"].Value));
        return true;
    }
}
