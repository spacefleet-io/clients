using System.Globalization;

namespace Jellyfin.Plugin.SpaceBadger.Playback;

/// <summary>The date media is removed from an unpaid account, written the way people say it ("15 November 2026").</summary>
public static class WipeDate
{
    public static string Format(string? iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date)
            ? date.UtcDateTime.ToString("d MMMM yyyy", CultureInfo.InvariantCulture)
            : (iso ?? string.Empty);
}
