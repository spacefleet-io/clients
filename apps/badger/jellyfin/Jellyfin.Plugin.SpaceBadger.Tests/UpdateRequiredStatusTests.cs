using System.Text.Json;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Xunit;

namespace Jellyfin.Plugin.SpaceBadger.Tests;

/// <summary>
/// REL-CD-29 / LIB-FMT-13 in the Jellyfin plugin: the sidecar's /status says the plugin must be updated; the plugin
/// reads the state and the sentence it shows on the settings page and writes to the activity log.
/// </summary>
public sealed class UpdateRequiredStatusTests
{
    [Fact]
    public void ReadsTheUpdateRequiredStateFromTheSidecarStatus()
    {
        const string body = """
            {"state":"update_required","signedIn":true,"accessState":"paid","mediaCount":0,"lastError":"update_required: api_refused",
             "keyRejected":false,"updateRequired":{"reason":"api_refused","minVersion":"0.3.0.0","at":"2026-11-21T10:00:00.000Z",
             "message":"SpaceFleet has been updated. Update the Badger plugin in Jellyfin (Dashboard > Plugins) to keep watching your library."}}
            """;
        var status = JsonSerializer.Deserialize<SbStatus>(body, SidecarClient.Json)!;
        Assert.Equal("update_required", status.State);
        Assert.NotNull(status.UpdateRequired);
        Assert.Equal("api_refused", status.UpdateRequired!.Reason);
        Assert.Equal("0.3.0.0", status.UpdateRequired.MinVersion);
        Assert.StartsWith("SpaceFleet has been updated.", status.UpdateRequired.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AStatusFromBeforeTheGateHasNoUpdateRequired()
    {
        var status = JsonSerializer.Deserialize<SbStatus>("""{"state":"ok","signedIn":true,"updateRequired":null}""", SidecarClient.Json)!;
        Assert.Null(status.UpdateRequired);
    }
}
