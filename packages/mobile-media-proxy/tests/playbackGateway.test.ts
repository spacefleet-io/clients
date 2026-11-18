/**
 * #145 one media = one silo: playback of a `media/<placementId>/…` media must
 * open the tunnel on the silo holding that placement (resolve endpoint), while
 * legacy media (placementId null) keeps the first-active-shard pick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPlacement } from "@space/shared/storagePlacement";

const SUITE = "playback-gateway-media-placement";

const apiMocks = vi.hoisted(() => ({
  resolveMediaPlacement: vi.fn<(token: string, placementId: string) => Promise<MediaPlacement>>(),
}));

// Everything but the media-placement resolve is the real facade, so /storage/placement goes through the SDK.
vi.mock("@space/shared/api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...apiMocks }));

import { setApiBaseUrl } from "@space/shared/api";
import { resolveGatewayCandidates } from "../src/playbackGateway";

const fetchMock = vi.fn<(request: Request) => Promise<Response>>();

const mediaPlacement = (): MediaPlacement =>
  ({
    placementId: "placement-film",
    poolId: "pool-1",
    shard: {
      id: "silo-b",
      gatewayUrl: "https://silo-b.example/",
      addresses: ["http://10.0.0.2:9000/", "https://silo-b.example"],
      status: "active",
    },
  }) as MediaPlacement;

beforeEach(() => {
  setApiBaseUrl("https://api.example/");
  apiMocks.resolveMediaPlacement.mockResolvedValue(mediaPlacement());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(`[${SUITE}] resolveGatewayCandidates`, () => {
  it("media placement → candidates from the resolved silo, no /storage/placement call", async () => {
    const candidates = await resolveGatewayCandidates("tok", "placement-film");
    console.info(`[${SUITE}:media] candidates=${JSON.stringify(candidates)}`);
    expect(apiMocks.resolveMediaPlacement).toHaveBeenCalledExactlyOnceWith("tok", "placement-film");
    expect(candidates).toEqual(["https://silo-b.example", "http://10.0.0.2:9000"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("legacy media (null) → first non-disabled shard of /storage/placement", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        policy: {
          shards: [
            { gatewayUrl: "https://silo-a.example", status: "disabled" },
            { gatewayUrl: "https://silo-c.example/", status: "active", addresses: ["http://10.0.0.3"] },
          ],
        },
      })
    );
    const candidates = await resolveGatewayCandidates("tok", null);
    const request = fetchMock.mock.calls[0]?.[0];
    console.info(`[${SUITE}:legacy] url=${request?.url} candidates=${JSON.stringify(candidates)}`);
    expect(request?.url).toBe("https://api.example/storage/placement");
    expect(request?.headers.get("Authorization")).toBe("Bearer tok");
    expect(request?.headers.get("x-space-app")).toBe("badger");
    expect(candidates).toEqual(["https://silo-c.example", "http://10.0.0.3"]);
    expect(apiMocks.resolveMediaPlacement).not.toHaveBeenCalled();
  });

  it("a down media silo surfaces the resolve error (no silent fallback to another silo)", async () => {
    apiMocks.resolveMediaPlacement.mockRejectedValue(new Error("placement_silo_unavailable"));
    await expect(resolveGatewayCandidates("tok", "placement-film")).rejects.toThrow("placement_silo_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
