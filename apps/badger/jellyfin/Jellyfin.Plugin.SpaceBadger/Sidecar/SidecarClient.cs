using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.SpaceBadger.Playback;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpaceBadger.Sidecar;

/// <summary>HTTP client for the localhost-only integration API of the Badger service (/integration/v1).</summary>
public sealed class SidecarClient
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly ILogger<SidecarClient> _logger;

    public SidecarClient(ILogger<SidecarClient> logger)
    {
        _logger = logger;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
    }

    /// <summary>Gets the base URL (always the loopback interface).</summary>
    public static string BaseUrl(int port) => $"http://127.0.0.1:{port}/integration/v1";

    private static string Base => BaseUrl(Plugin.Instance?.Configuration.SidecarPort ?? 8790);

    public Task<SbStatus> GetStatusAsync(CancellationToken ct) => GetJsonAsync<SbStatus>("status", ct);

    public Task<SbLibrary> GetLibraryAsync(CancellationToken ct) => GetJsonAsync<SbLibrary>("library", ct);

    public async Task<SbChanges> WaitChangesAsync(long since, int waitSeconds, CancellationToken ct) =>
        await GetJsonAsync<SbChanges>($"changes?since={since}&wait={waitSeconds}", ct).ConfigureAwait(false);

    public async Task<SbStatus> LoginAsync(string email, string password, string? twoFactorCode, string? apiUrl, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["email"] = email,
            ["password"] = password,
            ["twoFactorCode"] = string.IsNullOrWhiteSpace(twoFactorCode) ? null : twoFactorCode,
            ["apiUrl"] = string.IsNullOrWhiteSpace(apiUrl) ? null : apiUrl,
        };
        return await SendJsonAsync<SbStatus>(HttpMethod.Post, "login", body, ct).ConfigureAwait(false);
    }

    public Task<SbPairing> StartPairingAsync(string deviceName, string? apiUrl, CancellationToken ct) =>
        SendJsonAsync<SbPairing>(HttpMethod.Post, "pairing/start", new { deviceName, apiUrl = string.IsNullOrWhiteSpace(apiUrl) ? null : apiUrl }, ct);

    public async Task<SbPairing?> GetPairingAsync(CancellationToken ct) => (await GetJsonAsync<SbPairingStatus>("pairing/status", ct).ConfigureAwait(false)).Pairing;

    public Task CancelPairingAsync(CancellationToken ct) => SendJsonAsync<JsonElement>(HttpMethod.Post, "pairing/cancel", new { }, ct);

    public Task SignOutAsync(CancellationToken ct) => SendJsonAsync<JsonElement>(HttpMethod.Post, "signout", new { }, ct);

    /// <summary>The account's profiles and the one this server follows (INTG-PROF-01).</summary>
    public Task<SbProfiles> GetProfilesAsync(CancellationToken ct) => GetJsonAsync<SbProfiles>("profiles", ct);

    /// <summary>Picks the followed profile: finishes a pairing waiting for it, or changes it later (media stay, viewing state re-syncs).</summary>
    public Task<SbStatus> ChooseProfileAsync(string profileId, CancellationToken ct) =>
        SendJsonAsync<SbStatus>(HttpMethod.Post, "profile", new { profileId }, ct);

    public Task<SbProgressResult> PostProgressAsync(string mediaId, string? episodeId, double? positionSeconds, double? durationSeconds, bool? played, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["mediaId"] = mediaId,
            ["episodeId"] = episodeId,
            ["positionSeconds"] = positionSeconds,
            ["durationSeconds"] = durationSeconds,
            ["played"] = played,
        };
        return SendJsonAsync<SbProgressResult>(HttpMethod.Post, "progress", body, ct);
    }

    /// <summary>Reads the shared audio/subtitle choice of a movie or show (null fields = no choice recorded).</summary>
    public Task<TrackPreferences> GetTracksAsync(string mediaId, CancellationToken ct) =>
        GetJsonAsync<TrackPreferences>($"tracks/{Uri.EscapeDataString(mediaId)}", ct);

    /// <summary>Writes one field of the shared choice; the other stays as it is (only the keys present are changed).</summary>
    public Task PostTracksAsync(string mediaId, bool setAudio, string? audioLanguage, bool setSubtitle, SubtitleValue? subtitle, CancellationToken ct)
    {
        var body = new Dictionary<string, object?> { ["mediaId"] = mediaId };
        if (setAudio)
        {
            body["audioLanguage"] = audioLanguage;
        }

        if (setSubtitle)
        {
            body["subtitle"] = subtitle is null ? null : subtitle.Off ? "off" : subtitle.Choice;
        }

        return SendJsonAsync<JsonElement>(HttpMethod.Post, "tracks", body, ct);
    }

    public Task DeleteMediaAsync(string mediaId, CancellationToken ct) =>
        SendJsonAsync<JsonElement>(HttpMethod.Delete, $"media/{Uri.EscapeDataString(mediaId)}", null, ct);

    public Task<SbDeleteResult> DeleteEpisodeAsync(string mediaId, string episodeId, CancellationToken ct) =>
        SendJsonAsync<SbDeleteResult>(HttpMethod.Delete, $"media/{Uri.EscapeDataString(mediaId)}/{Uri.EscapeDataString(episodeId)}", null, ct);

    public async Task<SbImage> GetImageAsync(string reference, string kind, CancellationToken ct)
    {
        var url = $"{Base}/image?ref={Uri.EscapeDataString(reference)}&kind={Uri.EscapeDataString(kind)}";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, ct).ConfigureAwait(false);
        }

        return new SbImage
        {
            Bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false),
            ContentType = response.Content.Headers.ContentType?.MediaType ?? "image/jpeg",
        };
    }

    public async Task<byte[]> GetBytesAsync(string pathUnderApi, CancellationToken ct)
    {
        // Library paths already carry the /integration/v1 prefix; accept both forms.
        var path = pathUnderApi.StartsWith("/integration/v1/", StringComparison.Ordinal)
            ? pathUnderApi["/integration/v1/".Length..]
            : pathUnderApi.TrimStart('/');
        using var response = await _http.GetAsync($"{Base}/{path}", ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, ct).ConfigureAwait(false);
        }

        return await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    /// <summary>ACCT-STREAM-01/02: asks for the server's stream place for a Jellyfin session starting a Badger item.</summary>
    public Task<SbStreamAnswer> StartStreamAsync(string session, string item, string? deviceName, string language, CancellationToken ct) =>
        SendJsonAsync<SbStreamAnswer>(HttpMethod.Post, "stream/start", new { session, item, deviceName, language }, ct);

    /// <summary>ACCT-STREAM-02: whether the session still holds the place ("takenOver" once another device chose Play here).</summary>
    public Task<SbStreamAnswer> PollStreamAsync(string session, string language, CancellationToken ct) =>
        GetJsonAsync<SbStreamAnswer>($"stream/{Uri.EscapeDataString(session)}?language={Uri.EscapeDataString(language)}", ct);

    /// <summary>ACCT-STREAM-04: frees the place the session holds (a no-op for any other session).</summary>
    public Task StopStreamAsync(string session, CancellationToken ct) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "stream/stop", new { session }, ct);

    private async Task<T> GetJsonAsync<T>(string path, CancellationToken ct)
    {
        using var response = await _http.GetAsync($"{Base}/{path}", ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, ct).ConfigureAwait(false);
        }

        var value = await response.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false);
        return value ?? throw new SbSidecarException((int)response.StatusCode, "empty response");
    }

    private async Task<T> SendJsonAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, $"{Base}/{path}");
        if (body is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body, Json), Encoding.UTF8, "application/json");
        }

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, ct).ConfigureAwait(false);
        }

        var value = await response.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false);
        return value ?? throw new SbSidecarException((int)response.StatusCode, "empty response");
    }

    private async Task<SbSidecarException> ToExceptionAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        _logger.LogWarning("SpaceBadger service answered {Status} for {Method} {Url}: {Body}", (int)response.StatusCode, response.RequestMessage?.Method, response.RequestMessage?.RequestUri, text);
        return new SbSidecarException((int)response.StatusCode, $"service returned {(int)response.StatusCode}", text);
    }
}
