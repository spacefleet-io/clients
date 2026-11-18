using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>The remembered subtitle pick: a language (with the format and forced flag that tell several same-language tracks apart).</summary>
public sealed class SubtitleChoice
{
    public string Language { get; set; } = string.Empty;

    public string? Format { get; set; }

    public bool? Forced { get; set; }
}

/// <summary>
/// The synced per-movie / per-show audio and subtitle choice (PLAY-TRACK-04) of the followed profile (INTG-PROF-01):
/// the sidecar keeps it under <c>track_prefs_v1:&lt;mediaId&gt;</c> for the main profile and
/// <c>p:&lt;profileId&gt;:track_prefs_v1:&lt;mediaId&gt;</c> for any other; this plugin only goes through its tracks routes.
/// The wire shape is the shared contract: <c>subtitle</c> is the string <c>"off"</c>, an object, or null (no choice yet).
/// </summary>
public sealed class TrackPreferences
{
    public string? AudioLanguage { get; set; }

    [JsonConverter(typeof(SubtitleValueConverter))]
    public SubtitleValue? Subtitle { get; set; }

    public string? UpdatedAt { get; set; }
}

/// <summary>Subtitles switched off, or a picked language.</summary>
public sealed class SubtitleValue
{
    public bool Off { get; init; }

    public SubtitleChoice? Choice { get; init; }

    public static SubtitleValue TurnedOff { get; } = new() { Off = true };
}

public sealed class SubtitleValueConverter : JsonConverter<SubtitleValue?>
{
    public override SubtitleValue? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.String:
                return string.Equals(reader.GetString(), "off", StringComparison.Ordinal) ? SubtitleValue.TurnedOff : null;
            case JsonTokenType.StartObject:
                var choice = JsonSerializer.Deserialize<SubtitleChoice>(ref reader, options);
                return choice is { Language.Length: > 0 } ? new SubtitleValue { Choice = choice } : null;
            default:
                reader.Skip();
                return null;
        }
    }

    public override void Write(Utf8JsonWriter writer, SubtitleValue? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            writer.WriteNullValue();
        }
        else if (value.Off)
        {
            writer.WriteStringValue("off");
        }
        else
        {
            JsonSerializer.Serialize(writer, value.Choice, options);
        }
    }
}

/// <summary>Language matching and track picking for the shared choice, following the contract's resolution rules.</summary>
public static class TrackResolver
{
    // ISO 639-1 key -> every code that means the same language (contract table).
    private static readonly Dictionary<string, string> Aliases = BuildAliases();

    private static Dictionary<string, string> BuildAliases()
    {
        var table = new Dictionary<string, string[]>
        {
            ["en"] = ["eng"], ["fr"] = ["fre", "fra"], ["de"] = ["ger", "deu"], ["es"] = ["spa"], ["it"] = ["ita"],
            ["pt"] = ["por"], ["ru"] = ["rus"], ["ja"] = ["jpn"], ["ko"] = ["kor"], ["zh"] = ["chi", "zho"],
            ["nl"] = ["dut", "nld"], ["sv"] = ["swe"], ["no"] = ["nor", "nob", "nno"], ["da"] = ["dan"], ["fi"] = ["fin"],
            ["pl"] = ["pol"], ["tr"] = ["tur"], ["ar"] = ["ara"], ["he"] = ["heb"], ["hi"] = ["hin"],
            ["cs"] = ["cze", "ces"], ["hu"] = ["hun"], ["el"] = ["gre", "ell"], ["uk"] = ["ukr"], ["th"] = ["tha"],
            ["vi"] = ["vie"], ["id"] = ["ind"], ["ro"] = ["rum", "ron"], ["bg"] = ["bul"], ["fa"] = ["per", "fas"],
            ["is"] = ["ice", "isl"], ["ms"] = ["may", "msa"], ["bn"] = ["ben"],
        };
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (two, others) in table)
        {
            map[two] = two;
            foreach (var other in others)
            {
                map[other] = two;
            }
        }

        return map;
    }

    /// <summary>The form stored in the shared choice: lowercase ISO 639-1 when the language has one.</summary>
    public static string? Normalize(string? language)
    {
        var code = language?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(code) || code is "und" or "zxx" or "mis" or "mul")
        {
            return null;
        }

        return Aliases.TryGetValue(code, out var two) ? two : code;
    }

    public static bool SameLanguage(string? a, string? b)
    {
        var left = Normalize(a);
        return left is not null && left == Normalize(b);
    }

    /// <summary>Short format name the contract uses (srt, pgs, ...), from Jellyfin's codec name.</summary>
    public static string? FormatOf(MediaStream stream) => stream.Codec?.ToLowerInvariant() switch
    {
        "subrip" or "srt" => "srt",
        "webvtt" or "vtt" => "vtt",
        "pgssub" or "hdmv_pgs_subtitle" or "pgs" => "pgs",
        "dvdsub" or "dvd_subtitle" => "sub",
        "ass" => "ass",
        "ssa" => "ssa",
        "mov_text" => "mov_text",
        var other => other,
    };

    /// <summary>PGS bitmap subtitles are called "pgs" by Jellyfin and "sup" by the library; everything else compares by name.</summary>
    private static bool SameFormat(string? a, string? b)
    {
        static string Canonical(string? format) => format?.ToLowerInvariant() switch { "sup" => "pgs", var other => other ?? string.Empty };
        return Canonical(a) == Canonical(b);
    }

    public static MediaStream? ResolveAudio(TrackPreferences? prefs, IEnumerable<MediaStream> streams)
    {
        if (prefs?.AudioLanguage is not { Length: > 0 } wanted)
        {
            return null;
        }

        return streams
            .Where(s => s.Type == MediaStreamType.Audio && SameLanguage(s.Language, wanted))
            .OrderByDescending(s => s.IsDefault)
            .FirstOrDefault();
    }

    /// <summary>The track to show: null means "no opinion" (keep the default); the index -1 means off.</summary>
    public static int? ResolveSubtitleIndex(TrackPreferences? prefs, IEnumerable<MediaStream> streams)
    {
        if (prefs?.Subtitle is not { } value)
        {
            return null;
        }

        if (value.Off)
        {
            return -1;
        }

        var choice = value.Choice!;
        var candidates = streams.Where(s => s.Type == MediaStreamType.Subtitle && SameLanguage(s.Language, choice.Language)).ToList();
        if (candidates.Count == 0)
        {
            return null;
        }

        var forced = choice.Forced ?? false;
        var best = candidates
            .OrderByDescending(s => s.IsForced == forced)
            .ThenByDescending(s => choice.Format is { } f && SameFormat(FormatOf(s), f))
            .First();
        return best.Index;
    }
}
