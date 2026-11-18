using System.Collections.Concurrent;
using System.Globalization;
using Jellyfin.Plugin.SpaceBadger.Playback;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Sync;

/// <summary>
/// Generates the shortcut library (INTG-JF-02): one <c>.strm</c> per quality (movies: separate versions with the
/// original quality first, INTG-QUAL-01), <c>.nfo</c> metadata with the TMDB id and local artwork (INTG-META-01).
/// The <c>.strm</c> content is the local service's HLS master URL, which only Jellyfin ever opens (INTG-JF-03).
/// </summary>
public sealed class LibraryWriter
{
    public const string DeleteTagline = "Deleting this permanently removes it from Badger everywhere.";

    private static readonly char[] InvalidNameChars = "<>:\"/\\|?*".ToCharArray();
    private static readonly HashSet<string> SubtitleExtensions = new(StringComparer.OrdinalIgnoreCase) { "srt", "vtt", "ass", "ssa", "sup" };

    private readonly SidecarClient _client;
    private readonly ILogger<LibraryWriter> _logger;
    private readonly ConcurrentDictionary<string, DateTime> _expectedRemovals = new(StringComparer.Ordinal);

    public LibraryWriter(SidecarClient client, ILogger<LibraryWriter> logger)
    {
        _client = client;
        _logger = logger;
    }

    /// <summary>Gets the movie/show folders the libraries point at.</summary>
    public static string MoviesDir(string root) => Path.Combine(root, "movies");

    public static string ShowsDir(string root) => Path.Combine(root, "shows");

    /// <summary>True for a path the plugin itself removed in the last minutes (so deleting it is not a user delete).</summary>
    public bool WasRemovedByPlugin(string path)
    {
        foreach (var stale in _expectedRemovals.Where(entry => DateTime.UtcNow - entry.Value > TimeSpan.FromMinutes(30)).Select(entry => entry.Key).ToList())
        {
            _expectedRemovals.TryRemove(stale, out _);
        }

        return _expectedRemovals.ContainsKey(path);
    }

    /// <summary>
    /// Deletes the whole generated library and its index (the device signed out, ACCT-DEV-01). Every path is registered as a
    /// plugin removal first, so Jellyfin's resulting item removals are never forwarded as user deletes.
    /// </summary>
    public int RemoveAll(string root, string stateFile)
    {
        var removed = 0;
        foreach (var top in new[] { MoviesDir(root), ShowsDir(root) })
        {
            if (!Directory.Exists(top))
            {
                continue;
            }

            foreach (var entry in Directory.EnumerateFileSystemEntries(top, "*", SearchOption.AllDirectories))
            {
                _expectedRemovals[entry] = DateTime.UtcNow;
                if (File.Exists(entry))
                {
                    removed++;
                }
            }

            Directory.Delete(top, recursive: true);
        }

        if (File.Exists(stateFile))
        {
            File.Delete(stateFile);
        }

        _logger.LogInformation("SpaceBadger removed the generated library ({Count} files) from {Root}", removed, root);
        return removed;
    }

    /// <summary>Writes every file the library needs and removes what disappeared. Returns the number of files changed.</summary>
    public async Task<int> SyncAsync(SbLibrary library, string root, string stateFile, CancellationToken ct)
    {
        Directory.CreateDirectory(MoviesDir(root));
        Directory.CreateDirectory(ShowsDir(root));
        var previous = LoadIndex(stateFile);
        // Entries are reused and rewritten below: remember what each one owned BEFORE this run, so files an item still
        // exists under but no longer writes (a renamed episode file, a new version naming) are cleaned up too.
        var owned = previous.ToDictionary(p => p.Key, p => new HashSet<string>(p.Value.Files, StringComparer.Ordinal), StringComparer.Ordinal);
        var next = new Dictionary<string, IndexEntry>(StringComparer.Ordinal);
        var changed = 0;

        foreach (var movie in library.Movies)
        {
            ct.ThrowIfCancellationRequested();
            var entry = previous.GetValueOrDefault(movie.Id) ?? new IndexEntry();
            next[movie.Id] = entry;
            changed += await WriteMovieAsync(movie, root, entry, ct).ConfigureAwait(false);
        }

        foreach (var show in library.Shows)
        {
            ct.ThrowIfCancellationRequested();
            var entry = previous.GetValueOrDefault(show.Id) ?? new IndexEntry();
            next[show.Id] = entry;
            changed += await WriteShowAsync(show, root, entry, ct).ConfigureAwait(false);
        }

        // Anything the previous index owned that the new one does not is gone from Badger (or renamed): remove it.
        foreach (var (mediaId, oldFiles) in owned)
        {
            var keep = next.TryGetValue(mediaId, out var current) ? current.Files : new HashSet<string>(StringComparer.Ordinal);
            foreach (var relative in oldFiles.Where(file => !keep.Contains(file)))
            {
                changed += RemoveFile(Path.Combine(root, relative), root);
            }
        }

        SaveIndex(stateFile, next);
        return changed;
    }

    private async Task<int> WriteMovieAsync(SbMovie movie, string root, IndexEntry entry, CancellationToken ct)
    {
        var folderName = TitleFolder(movie.Title, movie.Year, movie.TmdbId);
        var folder = Path.Combine(MoviesDir(root), folderName);
        var written = new HashSet<string>(StringComparer.Ordinal);
        var changed = 0;

        changed += WriteText(root, Path.Combine(folder, "movie.nfo"), MovieNfo(movie), written);
        changed += await WriteImageAsync(root, folder, "poster", movie.PosterPath, "poster", entry, written, ct).ConfigureAwait(false);
        changed += await WriteImageAsync(root, folder, "fanart", movie.BackdropPath, "backdrop", entry, written, ct).ConfigureAwait(false);

        foreach (var version in movie.Versions)
        {
            var baseName = $"{folderName} - {SafeName(version.QualityKey)}";
            changed += WriteText(root, Path.Combine(folder, $"{baseName}.strm"), StrmUrl(version), written);
            changed += await WriteSubtitlesAsync(root, folder, baseName, movie, written, ct).ConfigureAwait(false);
        }

        entry.Files = written;
        return changed;
    }

    private async Task<int> WriteShowAsync(SbShow show, string root, IndexEntry entry, CancellationToken ct)
    {
        var folderName = TitleFolder(show.Title, show.Year, show.TmdbId);
        var folder = Path.Combine(ShowsDir(root), folderName);
        StrmRef.RememberShowFolder(folder, show.Id);
        var written = new HashSet<string>(StringComparer.Ordinal);
        var changed = 0;

        changed += WriteText(root, Path.Combine(folder, "tvshow.nfo"), ShowNfo(show), written);
        changed += await WriteImageAsync(root, folder, "poster", show.PosterPath, "poster", entry, written, ct).ConfigureAwait(false);
        changed += await WriteImageAsync(root, folder, "fanart", show.BackdropPath, "backdrop", entry, written, ct).ConfigureAwait(false);

        foreach (var season in show.Seasons)
        {
            var seasonFolder = Path.Combine(folder, $"Season {season.SeasonNumber:00}");
            foreach (var episode in season.Episodes)
            {
                ct.ThrowIfCancellationRequested();
                if (episode.Versions.Count == 0)
                {
                    continue;
                }

                // INTG-QUAL-01: one file per quality, same season/episode number, so Jellyfin groups them as versions of
                // one episode. The original comes first (it sorts as the default version).
                var showAndEpisode = $"{SafeName(show.Title)} - S{episode.SeasonNumber:00}E{episode.EpisodeNumber:00} - {SafeName(episode.Title)}";
                foreach (var version in episode.Versions.OrderByDescending(v => v.IsDefault))
                {
                    var baseName = $"{showAndEpisode} - {SafeName(version.QualityKey)}";
                    changed += WriteText(root, Path.Combine(seasonFolder, $"{baseName}.strm"), StrmUrl(version), written);
                    changed += WriteText(root, Path.Combine(seasonFolder, $"{baseName}.nfo"), EpisodeNfo(episode), written);
                    changed += await WriteImageAsync(root, seasonFolder, $"{baseName}-thumb", episode.StillPath, "still", entry, written, ct).ConfigureAwait(false);
                    changed += await WriteSubtitlesAsync(root, seasonFolder, baseName, episode, written, ct).ConfigureAwait(false);
                }
            }
        }

        entry.Files = written;
        return changed;
    }

    private static string StrmUrl(SbVersion version)
    {
        var port = Plugin.Instance?.Configuration.SidecarPort ?? 8790;
        var url = $"http://127.0.0.1:{port}{version.MasterPath}\n";
        if (version.IsDefault)
        {
            StrmRef.RememberDefault(url);
        }

        return url;
    }

    private int WriteText(string root, string absolute, string content, HashSet<string> written)
    {
        written.Add(Path.GetRelativePath(root, absolute));
        if (absolute.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            StrmRef.Remember(absolute, content);
            // The shortcut exists again (a re-pair after a sign-out writes the same paths): a later removal is the user's.
            _expectedRemovals.TryRemove(absolute, out _);
        }
        if (File.Exists(absolute) && string.Equals(File.ReadAllText(absolute), content, StringComparison.Ordinal))
        {
            return 0;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(absolute)!);
        var temp = absolute + ".tmp";
        File.WriteAllText(temp, content, new UTF8Encoding(false));
        File.Move(temp, absolute, overwrite: true);
        _logger.LogInformation("SpaceBadger wrote {Path}", absolute);
        return 1;
    }

    private async Task<int> WriteImageAsync(string root, string folder, string name, string? reference, string kind, IndexEntry entry, HashSet<string> written, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(reference))
        {
            return 0;
        }

        // Re-use an existing file for the same reference (any extension).
        var existing = Directory.Exists(folder)
            ? Directory.EnumerateFiles(folder, $"{name}.*").FirstOrDefault(f => !f.EndsWith(".tmp", StringComparison.Ordinal) && ImageExt(Path.GetExtension(f)))
            : null;
        var key = $"{name}|{folder}";
        if (existing is not null && entry.ImageRefs.TryGetValue(key, out var knownRef) && string.Equals(knownRef, reference, StringComparison.Ordinal))
        {
            written.Add(Path.GetRelativePath(root, existing));
            return 0;
        }

        try
        {
            var image = await _client.GetImageAsync(reference, kind, ct).ConfigureAwait(false);
            var extension = image.ContentType switch
            {
                "image/png" => "png",
                "image/webp" => "webp",
                _ => "jpg",
            };
            var absolute = Path.Combine(folder, $"{name}.{extension}");
            Directory.CreateDirectory(folder);
            if (existing is not null && !string.Equals(existing, absolute, StringComparison.Ordinal))
            {
                File.Delete(existing);
            }

            var temp = absolute + ".tmp";
            await File.WriteAllBytesAsync(temp, image.Bytes, ct).ConfigureAwait(false);
            File.Move(temp, absolute, overwrite: true);
            entry.ImageRefs[key] = reference;
            written.Add(Path.GetRelativePath(root, absolute));
            _logger.LogInformation("SpaceBadger wrote artwork {Path} ({Bytes} bytes)", absolute, image.Bytes.Length);
            return 1;
        }
        catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or IOException)
        {
            // Artwork is optional: keep the item, Jellyfin's own metadata refresh can still fill it in.
            _logger.LogWarning(ex, "SpaceBadger artwork {Reference} ({Kind}) not available", reference, kind);
            if (existing is not null)
            {
                written.Add(Path.GetRelativePath(root, existing));
            }

            return 0;
        }
    }

    private static bool ImageExt(string extension) => extension is ".jpg" or ".png" or ".webp";

    private async Task<int> WriteSubtitlesAsync(string root, string folder, string baseName, SbUnit unit, HashSet<string> written, CancellationToken ct)
    {
        var changed = 0;
        foreach (var track in unit.SubtitleTracks)
        {
            var extension = Path.GetExtension(track.Path).TrimStart('.');
            if (!SubtitleExtensions.Contains(extension))
            {
                continue; // formats Jellyfin cannot read as a subtitle file
            }

            var language = string.IsNullOrWhiteSpace(track.Language) ? "und" : track.Language;
            var suffix = track.IsDefault ? ".default" : string.Empty;
            var absolute = Path.Combine(folder, $"{baseName}.{language}.{track.Id[..Math.Min(8, track.Id.Length)]}{suffix}.{extension}");
            written.Add(Path.GetRelativePath(root, absolute));
            if (File.Exists(absolute))
            {
                continue;
            }

            try
            {
                var bytes = await _client.GetBytesAsync(track.Path, ct).ConfigureAwait(false);
                Directory.CreateDirectory(folder);
                await File.WriteAllBytesAsync(absolute, bytes, ct).ConfigureAwait(false);
                _logger.LogInformation("SpaceBadger wrote subtitle {Path}", absolute);
                changed++;
            }
            catch (Exception ex) when (ex is SbSidecarException or HttpRequestException or IOException)
            {
                _logger.LogWarning(ex, "SpaceBadger subtitle {Path} not available", track.Path);
                written.Remove(Path.GetRelativePath(root, absolute));
            }
        }

        return changed;
    }

    private int RemoveFile(string absolute, string root)
    {
        if (!File.Exists(absolute))
        {
            return 0;
        }

        if (absolute.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            _expectedRemovals[absolute] = DateTime.UtcNow;
        }

        File.Delete(absolute);
        _logger.LogInformation("SpaceBadger removed {Path}", absolute);
        var dir = Path.GetDirectoryName(absolute);
        while (!string.IsNullOrEmpty(dir) && dir.Length > root.Length && Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
        {
            Directory.Delete(dir);
            dir = Path.GetDirectoryName(dir);
        }

        return 1;
    }

    private static string SafeName(string value)
    {
        var cleaned = new string(value.Select(c => Array.IndexOf(InvalidNameChars, c) >= 0 || char.IsControl(c) ? '_' : c).ToArray()).Trim().TrimEnd('.');
        return string.IsNullOrWhiteSpace(cleaned) ? "Untitled" : cleaned;
    }

    private static string TitleFolder(string title, int? year, long? tmdbId)
    {
        var name = SafeName(title);
        if (year is > 0)
        {
            name += $" ({year})";
        }

        if (tmdbId is > 0)
        {
            name += $" [tmdbid-{tmdbId}]";
        }

        return name;
    }

    private static string Nfo(XElement root) =>
        new XDocument(new XDeclaration("1.0", "utf-8", "yes"), root).ToString(SaveOptions.None).Replace("\r\n", "\n", StringComparison.Ordinal) + "\n";

    private static void AddCommon(XElement root, SbTitle title)
    {
        root.Add(new XElement("title", title.Title));
        if (!string.IsNullOrWhiteSpace(title.OriginalTitle))
        {
            root.Add(new XElement("originaltitle", title.OriginalTitle));
        }

        root.Add(new XElement("plot", title.Overview ?? string.Empty));
        root.Add(new XElement("tagline", DeleteTagline));
        if (title.Year is > 0)
        {
            root.Add(new XElement("year", title.Year));
        }

        if (title.Rating is { } rating)
        {
            root.Add(new XElement("rating", rating.ToString("0.0", CultureInfo.InvariantCulture)));
        }

        foreach (var genre in title.Genres)
        {
            root.Add(new XElement("genre", genre));
        }

        if (title.TmdbId is { } tmdb)
        {
            root.Add(new XElement("tmdbid", tmdb), new XElement("uniqueid", new XAttribute("type", "tmdb"), new XAttribute("default", "true"), tmdb));
        }

        if (!string.IsNullOrWhiteSpace(title.ImdbId))
        {
            root.Add(new XElement("imdbid", title.ImdbId), new XElement("uniqueid", new XAttribute("type", "imdb"), title.ImdbId));
        }

        if (DateTimeOffset.TryParse(title.AddedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var added))
        {
            root.Add(new XElement("dateadded", added.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)));
        }

        var order = 0;
        foreach (var person in title.Cast)
        {
            root.Add(new XElement("actor", new XElement("name", person.Name), new XElement("role", person.Role ?? string.Empty), new XElement("order", order++)));
        }
    }

    private static string MovieNfo(SbMovie movie)
    {
        var root = new XElement("movie");
        AddCommon(root, movie);
        return Nfo(root);
    }

    private static string ShowNfo(SbShow show)
    {
        var root = new XElement("tvshow");
        AddCommon(root, show);
        return Nfo(root);
    }

    private static string EpisodeNfo(SbEpisode episode)
    {
        var root = new XElement(
            "episodedetails",
            new XElement("title", episode.ShownTitle ?? episode.Title),
            new XElement("season", episode.SeasonNumber),
            new XElement("episode", episode.EpisodeNumber),
            new XElement("plot", episode.Overview ?? string.Empty),
            new XElement("tagline", DeleteTagline));
        if (!string.IsNullOrWhiteSpace(episode.AirDate))
        {
            root.Add(new XElement("aired", episode.AirDate));
        }

        return Nfo(root);
    }

    private static Dictionary<string, IndexEntry> LoadIndex(string file)
    {
        try
        {
            if (File.Exists(file))
            {
                return JsonSerializer.Deserialize<Dictionary<string, IndexEntry>>(File.ReadAllText(file), SidecarClient.Json) ?? new();
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // A broken index only means files are rewritten; nothing is deleted without it.
        }

        return new Dictionary<string, IndexEntry>(StringComparer.Ordinal);
    }

    private static void SaveIndex(string file, Dictionary<string, IndexEntry> index)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, JsonSerializer.Serialize(index, SidecarClient.Json));
    }

    private sealed class IndexEntry
    {
        public HashSet<string> Files { get; set; } = new(StringComparer.Ordinal);

        public Dictionary<string, string> ImageRefs { get; set; } = new(StringComparer.Ordinal);
    }
}
