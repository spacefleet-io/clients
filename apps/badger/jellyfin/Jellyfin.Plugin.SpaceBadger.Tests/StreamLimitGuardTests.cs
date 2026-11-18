using Jellyfin.Plugin.SpaceBadger.Playback;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.SpaceBadger.Tests;

/// <summary>
/// ACCT-STREAM-01..04 in the Jellyfin plugin: each Badger playback asks the sidecar for the server's stream place; at
/// the limit, or when another device took the place, the viewer gets the shared text and the playback is stopped; a
/// stop gives the place back; the service unreachable plays without a place.
/// </summary>
public sealed class StreamLimitGuardTests
{
    private const string T = "[jf-stream-guard]";
    private readonly ITestOutputHelper _output;

    public StreamLimitGuardTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private sealed class FakeSidecar : IStreamPlaceSidecar
    {
        public List<string> Calls { get; } = new();

        public SbStreamAnswer StartAnswer { get; set; } = new() { Status = "play" };

        public SbStreamAnswer PollAnswer { get; set; } = new() { Status = "play" };

        public Exception? Failure { get; set; }

        public Task<SbStreamAnswer> StartAsync(string session, string item, string? deviceName, string language, CancellationToken ct)
        {
            Calls.Add($"start {session} {item} {deviceName} {language}");
            return Failure is null ? Task.FromResult(StartAnswer) : Task.FromException<SbStreamAnswer>(Failure);
        }

        public Task<SbStreamAnswer> PollAsync(string session, string language, CancellationToken ct)
        {
            Calls.Add($"poll {session} {language}");
            return Failure is null ? Task.FromResult(PollAnswer) : Task.FromException<SbStreamAnswer>(Failure);
        }

        public Task StopAsync(string session, CancellationToken ct)
        {
            Calls.Add($"stop {session}");
            return Failure is null ? Task.CompletedTask : Task.FromException(Failure);
        }
    }

    private sealed class FakePlayers : IStreamPlacePlayers
    {
        public List<string> Calls { get; } = new();

        public Task ShowMessageAsync(string session, string text, CancellationToken ct)
        {
            Calls.Add($"message {session}: {text}");
            return Task.CompletedTask;
        }

        public Task StopPlaybackAsync(string session, CancellationToken ct)
        {
            Calls.Add($"stop-playback {session}");
            return Task.CompletedTask;
        }
    }

    private static (FakeSidecar Sidecar, FakePlayers Players, StreamLimitGuard Guard) Setup()
    {
        var sidecar = new FakeSidecar();
        var players = new FakePlayers();
        return (sidecar, players, new StreamLimitGuard(sidecar, players, NullLogger.Instance));
    }

    private void Dump(string phase, FakeSidecar sidecar, FakePlayers players)
    {
        _output.WriteLine($"{T} phase: {phase}");
        _output.WriteLine($"{T} sidecar calls: {string.Join(" | ", sidecar.Calls)}");
        _output.WriteLine($"{T} player calls: {string.Join(" | ", players.Calls)}");
    }

    // @req ACCT-STREAM-01[badger-jellyfin]
    // @req ACCT-STREAM-04[badger-jellyfin]
    [Fact]
    public async Task StreamLimit_a_playback_takes_the_place_keeps_playing_and_gives_it_back_on_stop()
    {
        var (sidecar, players, guard) = Setup();
        var allowed = await guard.OnStartAsync("s1", "item-sintel", "Living room TV", "en-US", CancellationToken.None);
        var keeps = await guard.OnProgressAsync("s1", "en-US", CancellationToken.None);
        await guard.OnStoppedAsync("s1", CancellationToken.None);
        Dump("start, progress, stop", sidecar, players);

        Assert.True(allowed);
        Assert.True(keeps);
        Assert.Equal(new[] { "start s1 item-sintel Living room TV en-US", "poll s1 en-US", "stop s1" }, sidecar.Calls);
        Assert.Empty(players.Calls);
    }

    // @req ACCT-STREAM-02[badger-jellyfin]
    [Fact]
    public async Task StreamLimit_at_the_limit_the_viewer_gets_the_question_and_the_playback_stops()
    {
        var (sidecar, players, guard) = Setup();
        sidecar.StartAnswer = new SbStreamAnswer { Status = "limit", Text = "Already playing on Kitchen phone. Play here instead?" };
        var allowed = await guard.OnStartAsync("s1", "item-big-buck-bunny", "Kitchen tablet", "en", CancellationToken.None);
        Dump("start at the limit", sidecar, players);

        Assert.False(allowed);
        Assert.Equal(
            new[] { "message s1: Already playing on Kitchen phone. Play here instead?", "stop-playback s1" },
            players.Calls);
    }

    // @req ACCT-STREAM-02[badger-jellyfin]
    [Fact]
    public async Task StreamLimit_another_devices_play_here_stops_this_playback_with_its_name()
    {
        var (sidecar, players, guard) = Setup();
        await guard.OnStartAsync("s1", "item-tears-of-steel", "Bedroom", "fr", CancellationToken.None);
        sidecar.PollAnswer = new SbStreamAnswer { Status = "takenOver", Text = "Lecture en cours sur Office laptop" };
        var keeps = await guard.OnProgressAsync("s1", "fr", CancellationToken.None);
        Dump("taken over", sidecar, players);

        Assert.False(keeps);
        Assert.Equal(new[] { "message s1: Lecture en cours sur Office laptop", "stop-playback s1" }, players.Calls);
    }

    // @req ACCT-STREAM-01[badger-jellyfin]
    [Fact]
    public async Task StreamLimit_the_service_unreachable_plays_without_a_place()
    {
        var (sidecar, players, guard) = Setup();
        sidecar.Failure = new HttpRequestException("connection refused");
        var allowed = await guard.OnStartAsync("s1", "item-sintel", null, "en", CancellationToken.None);
        var keeps = await guard.OnProgressAsync("s1", "en", CancellationToken.None);
        await guard.OnStoppedAsync("s1", CancellationToken.None);
        Dump("service down", sidecar, players);

        Assert.True(allowed);
        Assert.True(keeps);
        Assert.Empty(players.Calls);
    }
}
