/**
 * @test-id PLAY-START-WARM-001
 * @level unit
 *
 * #934 (port of desktop #928): the details page starts the reads a play start waits on (library key, gateway lookup,
 * track prefs) so the tap on Play finds them done or in flight. The cache must never serve a stale or foreign answer:
 *  - one in-flight read per key, joined by later callers; gone after the TTL; dropped at once when it rejects,
 *  - entries belong to the auth token they were read under, and logout / key change clears them,
 *  - the player joins a warm read but never caches its own (a reload after an error reads again),
 *  - warm track prefs are used once, so a pick made in the player is not shadowed on the next play.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ keyReads: 0, gatewayReads: [] as Array<{ token: string; placementId: string | null }> }));

vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: async () => {
    ctl.keyReads += 1;
    return `key-${ctl.keyReads}`;
  },
}));
vi.mock("../src/lib/playbackGateway", () => ({
  resolveGatewayCandidates: async (token: string, placementId: string | null) => {
    ctl.gatewayReads.push({ token, placementId });
    return [`https://gw-${ctl.gatewayReads.length}`];
  },
}));

import {
  PLAY_START_WARM_TTL_MS,
  clearPlayStartWarm,
  peekPlayStartRead,
  rememberPlayStartRead,
  scopePlayStartReadsToToken,
  takePlayStartRead,
} from "../src/lib/playback/playStartCache";
import { gatewayCandidatesForPlay, libraryKeyForPlay, takeWarmTrackPrefs, warmPlayStart } from "../src/lib/playback/playStartWarm";

const TAG = "[play-start-warm]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const movie = {
  type: "movie" as const,
  episodes: [],
  files: [{ id: "f1" }],
  formats: [{ id: "fm1", fileId: "f1", initKey: "media/placement-1/init", chunks: [] }],
  audioTracks: [],
  subtitleTracks: [],
} as unknown as Parameters<typeof warmPlayStart>[0]["details"];

beforeEach(() => {
  clearPlayStartWarm();
  ctl.keyReads = 0;
  ctl.gatewayReads = [];
});

describe("@req PLAY-ABR-05[badger-mobile] play-start reads are shared, short-lived and never stale", () => {
  it("@req PLAY-ABR-05[badger-mobile] a second caller joins the read in flight instead of starting another", async () => {
    let starts = 0;
    const start = () => {
      starts += 1;
      return Promise.resolve(starts);
    };
    const a = rememberPlayStartRead("k", start, 1_000);
    const b = rememberPlayStartRead("k", start, 1_500);
    log("phase.joined", { starts });
    expect(b).toBe(a);
    expect(starts).toBe(1);
    expect(await peekPlayStartRead("k", 2_000)).toBe(1);
  });

  it("@req PLAY-ABR-05[badger-mobile] an entry expires after the TTL and the next caller reads again", async () => {
    let starts = 0;
    const start = () => Promise.resolve(++starts);
    await rememberPlayStartRead("k", start, 0);
    expect(peekPlayStartRead("k", PLAY_START_WARM_TTL_MS - 1)).not.toBeNull();
    expect(peekPlayStartRead("k", PLAY_START_WARM_TTL_MS)).toBeNull();
    expect(await rememberPlayStartRead("k", start, PLAY_START_WARM_TTL_MS)).toBe(2);
  });

  it("@req PLAY-ABR-05[badger-mobile] a read that fails is dropped at once so the next caller retries", async () => {
    const failed = rememberPlayStartRead("k", () => Promise.reject(new Error("keychain locked")), 0);
    await expect(failed).rejects.toThrow("keychain locked");
    log("phase.after-reject", { cached: peekPlayStartRead("k", 1) !== null });
    expect(peekPlayStartRead("k", 1)).toBeNull();
    expect(await rememberPlayStartRead("k", () => Promise.resolve("ok"), 2)).toBe("ok");
  });

  it("@req PLAY-ABR-05[badger-mobile] take hands the read out once; another token or a clear empties the cache", async () => {
    void rememberPlayStartRead("once", () => Promise.resolve(1), 0);
    expect(takePlayStartRead("once", 1)).not.toBeNull();
    expect(takePlayStartRead("once", 2)).toBeNull();

    scopePlayStartReadsToToken("token-a");
    void rememberPlayStartRead("k", () => Promise.resolve(1), 0);
    scopePlayStartReadsToToken("token-a");
    expect(peekPlayStartRead("k", 1)).not.toBeNull();
    scopePlayStartReadsToToken("token-b");
    expect(peekPlayStartRead("k", 1)).toBeNull();

    void rememberPlayStartRead("k", () => Promise.resolve(1), 0);
    clearPlayStartWarm();
    expect(peekPlayStartRead("k", 1)).toBeNull();
  });

  it("@req PLAY-ABR-05[badger-mobile] the player joins what the details page warmed: one key read, one gateway lookup", async () => {
    const readTrackPrefs = vi.fn(async () => ({ audio: "fr" }) as never);
    warmPlayStart({ token: "token-a", mediaId: "m1", details: movie, episodeId: null, readTrackPrefs });
    log("phase.warmed", { keyReads: ctl.keyReads, gatewayReads: ctl.gatewayReads });

    expect(await libraryKeyForPlay()).toBe("key-1");
    expect(await gatewayCandidatesForPlay("token-a", "placement-1")).toEqual(["https://gw-1"]);
    expect(ctl.keyReads).toBe(1);
    expect(ctl.gatewayReads).toEqual([{ token: "token-a", placementId: "placement-1" }]);
    expect(readTrackPrefs).toHaveBeenCalledTimes(1);
  });

  it("@req PLAY-ABR-05[badger-mobile] the player's own reads are not cached: a reload reads again", async () => {
    await libraryKeyForPlay();
    await libraryKeyForPlay();
    await gatewayCandidatesForPlay("token-a", "placement-1");
    await gatewayCandidatesForPlay("token-a", "placement-1");
    log("phase.cold", { keyReads: ctl.keyReads, gatewayReads: ctl.gatewayReads.length });
    expect(ctl.keyReads).toBe(2);
    expect(ctl.gatewayReads).toHaveLength(2);
  });

  it("@req PLAY-ABR-05[badger-mobile] a lookup warmed under one account is not served to another", async () => {
    warmPlayStart({ token: "token-a", mediaId: "m1", details: movie, episodeId: null, readTrackPrefs: async () => null });
    expect(await gatewayCandidatesForPlay("token-b", "placement-1")).toEqual(["https://gw-2"]);
    expect(ctl.gatewayReads.map((read) => read.token)).toEqual(["token-a", "token-b"]);
  });

  it("@req PLAY-TRACK-04[badger-mobile] warm track prefs are used once, so a pick made in the player wins next time", async () => {
    warmPlayStart({ token: null, mediaId: "m1", details: movie, episodeId: null, readTrackPrefs: async () => ({ audio: "fr" }) as never });
    expect(await takeWarmTrackPrefs("m1")).toEqual({ audio: "fr" });
    expect(takeWarmTrackPrefs("m1")).toBeNull();
    log("phase.no-token", { gatewayReads: ctl.gatewayReads.length });
    expect(ctl.gatewayReads).toHaveLength(0);
  });
});
