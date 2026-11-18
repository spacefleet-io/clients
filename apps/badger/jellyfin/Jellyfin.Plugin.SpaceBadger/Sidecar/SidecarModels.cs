namespace Jellyfin.Plugin.SpaceBadger.Sidecar;

// Mirrors apps/badger/jellyfin/sidecar/src/library.ts (IntegrationLibrary). Only fields the plugin uses.

public sealed class SbStatus
{
    public string State { get; set; } = "starting";
    public bool SignedIn { get; set; }
    public string? Email { get; set; }
    public string? UserId { get; set; }
    public string AccessState { get; set; } = "unknown";
    public string? PaidUntil { get; set; }
    public string? WipeAt { get; set; }
    public long? LibraryVersion { get; set; }
    public int MediaCount { get; set; }
    public string? LastSyncAt { get; set; }
    public string? LastError { get; set; }
    public string? ApiUrl { get; set; }
    public string? Version { get; set; }
    public SbPairing? Pairing { get; set; }
    public string? SignedOutReason { get; set; }
    public bool KeyRejected { get; set; }

    /// <summary>The one profile this server follows (INTG-PROF-01); null until picked.</summary>
    public SbProfileRef? Profile { get; set; }

    /// <summary>The account's profiles (oldest first) from the sidecar's last list.</summary>
    public List<SbProfile>? Profiles { get; set; }

    /// <summary>INTG-PROF-01: why no profile is followed outside pairing: "deleted" (deleted elsewhere) or "choose" (a session from before profiles on an account with several); null otherwise.</summary>
    public string? ProfileNeeded { get; set; }
}

public sealed class SbProfileRef
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public bool IsMain { get; set; }
}

public sealed class SbProfile
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int Avatar { get; set; }
    public string? CreatedAt { get; set; }
    public bool IsMain { get; set; }
}

public sealed class SbProfiles
{
    public SbProfileRef? Profile { get; set; }
    public List<SbProfile> Profiles { get; set; } = new();

    /// <summary>True while nothing syncs because no profile is picked yet.</summary>
    public bool Required { get; set; }
}

/// <summary>A pairing code the user approves from their phone or desktop (ACCT-PAIR-01).</summary>
public sealed class SbPairing
{
    public string State { get; set; } = "pending";
    public string? ShortCode { get; set; }
    public string? QrPayload { get; set; }
    public string? ExpiresAt { get; set; }
    public string? DeviceName { get; set; }
    public string? Error { get; set; }
}

public sealed class SbPairingStatus
{
    public SbPairing? Pairing { get; set; }
}

public sealed class SbDeleteResult
{
    public bool Ok { get; set; }
    public bool DeletedFile { get; set; }
}

public sealed class SbChanges
{
    public long Version { get; set; }
    public bool Changed { get; set; }
}

public sealed class SbVersion
{
    public string QualityKey { get; set; } = string.Empty;
    public string Quality { get; set; } = string.Empty;
    public string Codec { get; set; } = string.Empty;
    public bool IsSource { get; set; }
    public bool IsDefault { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public string MasterPath { get; set; } = string.Empty;
}

public sealed class SbResume
{
    public double ProgressPct { get; set; }
    public double? PositionSeconds { get; set; }
    public double? DurationSeconds { get; set; }
    public string? UpdatedAt { get; set; }
    public bool Watched { get; set; }
}

public sealed class SbAudio
{
    public string Id { get; set; } = string.Empty;
    public string Language { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public bool IsDefault { get; set; }
}

public sealed class SbSubtitle
{
    public string Id { get; set; } = string.Empty;
    public string Language { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string? Format { get; set; }
    public bool IsDefault { get; set; }
    public string Path { get; set; } = string.Empty;
}

public class SbUnit
{
    public double? DurationSeconds { get; set; }
    public List<SbVersion> Versions { get; set; } = new();
    public List<SbAudio> AudioTracks { get; set; } = new();
    public List<SbSubtitle> SubtitleTracks { get; set; } = new();
    public SbResume? Resume { get; set; }
}

public sealed class SbCast
{
    public string Name { get; set; } = string.Empty;
    public string? Role { get; set; }
}

public class SbTitle : SbUnit
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? OriginalTitle { get; set; }
    public int? Year { get; set; }
    public string? Overview { get; set; }
    public double? Rating { get; set; }
    public List<string> Genres { get; set; } = new();
    public string? AddedAt { get; set; }
    public string? PosterPath { get; set; }
    public string? BackdropPath { get; set; }
    public string? PreferredAudioLanguage { get; set; }
    public List<SbCast> Cast { get; set; } = new();
}

public sealed class SbMovie : SbTitle
{
}

public sealed class SbEpisode : SbUnit
{
    public string Id { get; set; } = string.Empty;
    public int SeasonNumber { get; set; }
    public int EpisodeNumber { get; set; }
    public string Title { get; set; } = string.Empty;

    /// <summary>Gets or sets the episode name in Jellyfin's interface language (LIB-LANG-01), null when none is kept.
    /// File names keep <see cref="Title"/>, so a language change renames nothing.</summary>
    public string? ShownTitle { get; set; }

    public string? Overview { get; set; }
    public string? AirDate { get; set; }
    public string? StillPath { get; set; }
}

public sealed class SbSeason
{
    public int SeasonNumber { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Overview { get; set; }
    public string? PosterPath { get; set; }
    public List<SbEpisode> Episodes { get; set; } = new();
}

public sealed class SbShow : SbTitle
{
    public List<SbSeason> Seasons { get; set; } = new();
}

public sealed class SbLibrary
{
    public long Version { get; set; }
    public string? GeneratedAt { get; set; }
    public List<SbMovie> Movies { get; set; } = new();
    public List<SbShow> Shows { get; set; } = new();
}

public sealed class SbImage
{
    public byte[] Bytes { get; set; } = Array.Empty<byte>();
    public string ContentType { get; set; } = "image/jpeg";
}

public sealed class SbProgressResult
{
    public bool Recorded { get; set; }
    public string? Kind { get; set; }
    public string? Reason { get; set; }
}

/// <summary>
/// ACCT-STREAM-01/02: the sidecar's answer about the server's stream place for one Jellyfin session
/// (apps/badger/jellyfin/sidecar/src/streamSlots.ts). Status is "play", "limit", "takenOver" or "idle";
/// Text is the shared prompt (packages/stream-slots/src/strings.ts) for "limit" and "takenOver".
/// </summary>
public sealed class SbStreamAnswer
{
    public string Status { get; set; } = "idle";
    public bool Takeover { get; set; }
    public string? Text { get; set; }
}

public sealed class SbSidecarException : Exception
{
    public SbSidecarException(int statusCode, string message, string? body = null)
        : base(message)
    {
        StatusCode = statusCode;
        Body = body;
    }

    public int StatusCode { get; }

    public string? Body { get; }
}
