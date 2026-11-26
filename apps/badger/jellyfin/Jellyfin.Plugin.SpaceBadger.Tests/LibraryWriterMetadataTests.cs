using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Xml.Linq;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Plugin.SpaceBadger.Sync;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.SpaceBadger.Tests;

/// <summary>
/// INTG-META-01 (Jellyfin half): the plugin writes `.nfo` files and local images beside each shortcut, from the Badger
/// library the sidecar serves (titles, descriptions, years, seasons, episodes; no catalog id, META-SRC-09), and the artwork it fetches
/// through the sidecar's `image` route. A match the user fixed by hand arrives as new library values and replaces what
/// was written before. The fake sidecar here answers `/integration/v1/image` on a loopback port.
/// </summary>
public sealed class LibraryWriterMetadataTests : IDisposable
{
    private static readonly byte[] Jpeg = { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46 };
    private static readonly byte[] Png = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };

    private readonly string _root = Directory.CreateTempSubdirectory("sf-jf-meta-").FullName;
    private readonly ITestOutputHelper _output;
    private readonly HttpListener _listener = new();
    private readonly ConcurrentQueue<string> _imageRequests = new();
    private readonly CancellationTokenSource _stop = new();

    public LibraryWriterMetadataTests(ITestOutputHelper output)
    {
        _output = output;
        var port = FreePort();
        _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        _listener.Start();
        _ = Task.Run(ServeAsync);
        Plugin.Instance = new Plugin();
        Plugin.Instance.Configuration.SidecarPort = port;
        Phase("setup", $"fake sidecar on port {port}, library root {_root}");
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Close();
        Directory.Delete(_root, recursive: true);
    }

    // @req INTG-META-01[badger-jellyfin]
    [Fact]
    public async Task WritesNfoAndLocalArtworkFromTheBadgerLibrary()
    {
        var writer = new LibraryWriter(new SidecarClient(NullLogger<SidecarClient>.Instance), NullLogger<LibraryWriter>.Instance);
        var library = new SbLibrary { Version = 3, Movies = { Arrival() }, Shows = { Severance() } };

        Phase("write", $"movies={library.Movies.Count} shows={library.Shows.Count}");
        var changed = await writer.SyncAsync(library, _root, StateFile(), CancellationToken.None);
        DumpTree("after first sync");
        Phase("write", $"changed={changed} images asked: {string.Join(", ", _imageRequests)}");

        var movieFolder = Path.Combine(LibraryWriter.MoviesDir(_root), "Arrival (2016)");
        var movie = XDocument.Load(Path.Combine(movieFolder, "movie.nfo")).Root!;
        Assert.Equal("movie", movie.Name.LocalName);
        Assert.Equal("Arrival", movie.Element("title")!.Value);
        Assert.Equal("A linguist works with the military to communicate with alien lifeforms.", movie.Element("plot")!.Value);
        Assert.Equal("2016", movie.Element("year")!.Value);
        Assert.Empty(movie.Elements("uniqueid"));
        // META-SRC-05: no rating of any kind reaches Jellyfin.
        Assert.Empty(movie.Elements("rating"));
        Assert.Empty(movie.Elements("criticrating"));
        Assert.Empty(movie.Elements("ratings"));
        Assert.Equal(new[] { "Drama", "Science Fiction" }, movie.Elements("genre").Select(e => e.Value));
        // Jellyfin's own metadata refresh stays allowed: nothing is locked.
        Assert.Null(movie.Element("lockdata"));
        Assert.Equal(Jpeg, File.ReadAllBytes(Path.Combine(movieFolder, "poster.jpg")));
        Assert.Equal(Png, File.ReadAllBytes(Path.Combine(movieFolder, "fanart.png")));

        var showFolder = Path.Combine(LibraryWriter.ShowsDir(_root), "Severance (2022)");
        var show = XDocument.Load(Path.Combine(showFolder, "tvshow.nfo")).Root!;
        Assert.Equal("tvshow", show.Name.LocalName);
        Assert.Equal("Severance", show.Element("title")!.Value);
        Assert.Empty(show.Elements("uniqueid"));
        Assert.Equal("2022", show.Element("year")!.Value);
        Assert.True(File.Exists(Path.Combine(showFolder, "poster.jpg")));
        Assert.True(File.Exists(Path.Combine(showFolder, "fanart.png")));

        var s1 = Path.Combine(showFolder, "Season 01");
        var s2 = Path.Combine(showFolder, "Season 02");
        var e1 = XDocument.Load(Path.Combine(s1, "Severance - S01E01 - Good News About Hell - 1080p.nfo")).Root!;
        Assert.Equal("episodedetails", e1.Name.LocalName);
        Assert.Equal(("Good News About Hell", "1", "1", "Mark is promoted.", "2022-02-18"), (e1.Element("title")!.Value, e1.Element("season")!.Value, e1.Element("episode")!.Value, e1.Element("plot")!.Value, e1.Element("aired")!.Value));
        Assert.True(File.Exists(Path.Combine(s1, "Severance - S01E01 - Good News About Hell - 1080p.strm")));
        Assert.True(File.Exists(Path.Combine(s1, "Severance - S01E01 - Good News About Hell - 1080p-thumb.jpg")));
        var e3 = XDocument.Load(Path.Combine(s2, "Severance - S02E01 - Hello, Ms. Cobel - 1080p.nfo")).Root!;
        Assert.Equal(("2", "1"), (e3.Element("season")!.Value, e3.Element("episode")!.Value));

        // Pictures came from the sidecar's image route, by library reference and kind.
        Assert.Contains("ref=/arrival-poster.jpg&kind=poster", _imageRequests);
        Assert.Contains("ref=/arrival-backdrop.png&kind=backdrop", _imageRequests);
        Assert.Contains("ref=/e1.jpg&kind=still", _imageRequests);
    }

    // @req INTG-META-01[badger-jellyfin]
    [Fact]
    public async Task AHandFixedMatchReplacesTheWrittenTitleAndArtwork()
    {
        var writer = new LibraryWriter(new SidecarClient(NullLogger<SidecarClient>.Instance), NullLogger<LibraryWriter>.Instance);
        var wrong = Arrival();
        await writer.SyncAsync(new SbLibrary { Version = 1, Movies = { wrong } }, _root, StateFile(), CancellationToken.None);
        DumpTree("before the fix");

        // The user fixed the match in Badger: same media id, now "Contact" with its own pictures.
        var fixedMatch = Arrival();
        fixedMatch.Title = "Contact";
        fixedMatch.OriginalTitle = "Contact";
        fixedMatch.Year = 1997;
        fixedMatch.Overview = "Dr. Ellie Arroway finds a signal.";
        fixedMatch.PosterPath = "/contact-poster.jpg";
        fixedMatch.BackdropPath = "/contact-backdrop.jpg";
        var changed = await writer.SyncAsync(new SbLibrary { Version = 2, Movies = { fixedMatch } }, _root, StateFile(), CancellationToken.None);
        DumpTree("after the fix");
        Phase("fix", $"changed={changed}");

        var oldFolder = Path.Combine(LibraryWriter.MoviesDir(_root), "Arrival (2016)");
        var newFolder = Path.Combine(LibraryWriter.MoviesDir(_root), "Contact (1997)");
        Assert.False(File.Exists(Path.Combine(oldFolder, "movie.nfo")));
        Assert.False(File.Exists(Path.Combine(oldFolder, "poster.jpg")));
        var nfo = XDocument.Load(Path.Combine(newFolder, "movie.nfo")).Root!;
        Assert.Equal("Contact", nfo.Element("title")!.Value);
        Assert.Empty(nfo.Elements("uniqueid"));
        Assert.Equal("Dr. Ellie Arroway finds a signal.", nfo.Element("plot")!.Value);
        Assert.True(File.Exists(Path.Combine(newFolder, "poster.jpg")));
        Assert.Contains("ref=/contact-poster.jpg&kind=poster", _imageRequests);
    }

    // @req LIB-LANG-01[badger-jellyfin]
    [Fact]
    public async Task EpisodeTextsInTheInterfaceLanguageGoToTheNfoAndFileNamesStay()
    {
        var writer = new LibraryWriter(new SidecarClient(NullLogger<SidecarClient>.Instance), NullLogger<LibraryWriter>.Instance);
        await writer.SyncAsync(new SbLibrary { Version = 1, Shows = { Severance() } }, _root, StateFile(), CancellationToken.None);
        var season = Path.Combine(LibraryWriter.ShowsDir(_root), "Severance (2022)", "Season 01");
        var baseName = "Severance - S01E01 - Good News About Hell - 1080p";
        var strmBefore = File.ReadAllText(Path.Combine(season, baseName + ".strm"));

        // The sidecar now holds French texts for the show: same stored title, a shown title and synopsis beside it.
        var french = Severance();
        french.Overview = "Mark dirige une équipe dont les souvenirs ont été divisés.";
        var episode = french.Seasons[0].Episodes[0];
        episode.ShownTitle = "Bonne nouvelle de l'enfer";
        episode.Overview = "Mark est promu.";
        var changed = await writer.SyncAsync(new SbLibrary { Version = 2, Shows = { french } }, _root, StateFile(), CancellationToken.None);
        DumpTree("after the French texts");
        Phase("lib-lang-01", $"changed={changed}");

        Assert.Equal(strmBefore, File.ReadAllText(Path.Combine(season, baseName + ".strm")));
        Assert.Single(Directory.GetFiles(season, "*S01E01*.strm"));
        var nfo = XDocument.Load(Path.Combine(season, baseName + ".nfo")).Root!;
        Assert.Equal("Bonne nouvelle de l'enfer", nfo.Element("title")!.Value);
        Assert.Equal("Mark est promu.", nfo.Element("plot")!.Value);
        var show = XDocument.Load(Path.Combine(LibraryWriter.ShowsDir(_root), "Severance (2022)", "tvshow.nfo")).Root!;
        Assert.Equal("Mark dirige une équipe dont les souvenirs ont été divisés.", show.Element("plot")!.Value);
        var other = XDocument.Load(Path.Combine(season, "Severance - S01E02 - Half Loop - 1080p.nfo")).Root!;
        Assert.Equal("Half Loop", other.Element("title")!.Value);
        Assert.Equal(2, changed);
    }

    private static SbMovie Arrival() => new()
    {
        Id = "movie-1",
        Title = "Arrival",
        OriginalTitle = "Arrival",
        Year = 2016,
        Overview = "A linguist works with the military to communicate with alien lifeforms.",
        Genres = { "Drama", "Science Fiction" },
        AddedAt = "2026-01-01T00:00:00.000Z",
        PosterPath = "/arrival-poster.jpg",
        BackdropPath = "/arrival-backdrop.png",
        Versions = { Version("/integration/v1/media/movie-1/1080p/master.m3u8") },
    };

    private static SbShow Severance() => new()
    {
        Id = "show-1",
        Title = "Severance",
        Year = 2022,
        Overview = "Mark leads a team of office workers whose memories have been surgically divided.",
        PosterPath = "/severance-poster.jpg",
        BackdropPath = "/severance-backdrop.png",
        Seasons =
        {
            new SbSeason
            {
                SeasonNumber = 1,
                Name = "Season 1",
                Episodes =
                {
                    Episode("e1", 1, 1, "Good News About Hell", "Mark is promoted.", "2022-02-18", "/e1.jpg"),
                    Episode("e2", 1, 2, "Half Loop", "Helly tries to quit.", "2022-02-18", "/e2.jpg"),
                },
            },
            new SbSeason { SeasonNumber = 2, Name = "Season 2", Episodes = { Episode("e3", 2, 1, "Hello, Ms. Cobel", null, "2025-01-17", "/e3.jpg") } },
        },
    };

    private static SbEpisode Episode(string id, int season, int number, string title, string? overview, string airDate, string still) => new()
    {
        Id = id,
        SeasonNumber = season,
        EpisodeNumber = number,
        Title = title,
        Overview = overview,
        AirDate = airDate,
        StillPath = still,
        Versions = { Version($"/integration/v1/media/show-1/{id}/1080p/master.m3u8") },
    };

    private static SbVersion Version(string master) => new() { QualityKey = "1080p", IsDefault = true, MasterPath = master };

    private async Task ServeAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }
            catch (HttpListenerException)
            {
                return;
            }

            var url = context.Request.Url!;
            if (url.AbsolutePath == "/integration/v1/image")
            {
                var reference = context.Request.QueryString["ref"] ?? string.Empty;
                _imageRequests.Enqueue($"ref={reference}&kind={context.Request.QueryString["kind"]}");
                var png = reference.EndsWith(".png", StringComparison.Ordinal);
                context.Response.ContentType = png ? "image/png" : "image/jpeg";
                var body = png ? Png : Jpeg;
                await context.Response.OutputStream.WriteAsync(body).ConfigureAwait(false);
            }
            else
            {
                context.Response.StatusCode = 404;
            }

            context.Response.Close();
        }
    }

    private string StateFile() => Path.Combine(_root, "state", "library-index.json");

    private void DumpTree(string label)
    {
        var files = Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories).Select(f => Path.GetRelativePath(_root, f)).Order(StringComparer.Ordinal);
        Phase("state", $"{label}: {JsonSerializer.Serialize(files)}");
    }

    private void Phase(string phase, string message) => _output.WriteLine($"[intg-meta-01] {phase}: {message}");

    private static int FreePort()
    {
        using var socket = new TcpListener(IPAddress.Loopback, 0);
        socket.Start();
        return ((IPEndPoint)socket.LocalEndpoint).Port;
    }
}
