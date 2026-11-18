import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { resolvePlayableUnit } from "../src/library";
import { loadIntegrationConfig } from "../src/config";
import {
  buildHlsExtinfDurations,
  buildMasterPlaylist,
  buildTrackPlaylist,
  objectUrl,
  segmentsFromChunks,
  type HlsUnit,
} from "../src/hls";
import {
  decryptLibraryEnvelope,
  decryptMediaObject,
  deriveMediaMasterKey,
  encryptLibraryEnvelope,
  encryptMediaObject,
  hasSfv1Magic,
  parseLibraryKey,
} from "../src/mediaCrypto";
import { decideProgress, isWatchedProgress } from "../src/progress";
import {
  errorResponse,
  handleIntegrationRequest,
  parseMediaRoute,
  type IntegrationDeps,
  type IntegrationStatus,
} from "../src/server";

describe("integration progress thresholds", () => {
  it("@req INTG-SYNC-01[badger-jellyfin] ignores a start below 2% and below 15 seconds", () => {
    expect(decideProgress({ positionSeconds: 5, durationSeconds: 7200 })).toEqual({
      kind: "ignore",
      reason: "below_resume_threshold",
    });
  });

  it("@req INTG-SYNC-01[badger-jellyfin] keeps a resume from 15 seconds even when that is under 2%", () => {
    const decision = decideProgress({ positionSeconds: 15, durationSeconds: 7200 });
    expect(decision.kind).toBe("resume");
  });

  it("@req INTG-SYNC-01[badger-jellyfin] keeps a resume from 2% even when that is under 15 seconds", () => {
    const decision = decideProgress({ positionSeconds: 4, durationSeconds: 100 });
    expect(decision.kind).toBe("resume");
  });

  it("@req INTG-SYNC-01[badger-jellyfin] marks watched at 95% and stores 100", () => {
    expect(decideProgress({ positionSeconds: 95, durationSeconds: 100 })).toMatchObject({ kind: "watched", progressPct: 100 });
    expect(decideProgress({ positionSeconds: 94, durationSeconds: 100 }).kind).toBe("resume");
  });

  it("@req INTG-SYNC-01[badger-jellyfin] marks watched once past the credits start", () => {
    expect(decideProgress({ positionSeconds: 70, durationSeconds: 100, creditsStartSeconds: 60 }).kind).toBe("watched");
    expect(decideProgress({ positionSeconds: 50, durationSeconds: 100, creditsStartSeconds: 60 }).kind).toBe("resume");
    expect(isWatchedProgress({ progressPct: 70, positionSeconds: 70, creditsStartSeconds: 60 })).toBe(true);
    expect(isWatchedProgress({ progressPct: 50, positionSeconds: 50, creditsStartSeconds: 60 })).toBe(false);
  });

  it("rejects unusable numbers", () => {
    expect(decideProgress({ positionSeconds: Number.NaN, durationSeconds: 100 })).toEqual({ kind: "ignore", reason: "invalid" });
    expect(decideProgress({ positionSeconds: 10, durationSeconds: 0 })).toEqual({ kind: "ignore", reason: "invalid" });
  });
});

describe("integration media crypto", () => {
  const libraryKey = randomBytes(32);

  it("@req PRIV-ENC-01[badger-jellyfin] round-trips an SFV1 media object and rejects a tampered one", () => {
    const master = deriveMediaMasterKey(libraryKey);
    const plain = randomBytes(5000);
    const encrypted = encryptMediaObject(master, plain, 64);
    expect(hasSfv1Magic(encrypted)).toBe(true);
    expect(decryptMediaObject(master, encrypted).equals(plain)).toBe(true);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptMediaObject(master, tampered)).toThrow();
    expect(() => decryptMediaObject(deriveMediaMasterKey(randomBytes(32)), encrypted)).toThrow();
  });

  it("@req PRIV-KEY-01[badger-jellyfin] round-trips the library envelope with the library key", () => {
    const plain = Buffer.from("snapshot bytes");
    const envelope = encryptLibraryEnvelope(libraryKey, plain);
    expect(decryptLibraryEnvelope(libraryKey, envelope).equals(plain)).toBe(true);
  });

  it("parses a base64 library key and rejects a wrong length", () => {
    expect(parseLibraryKey(libraryKey.toString("base64")).equals(libraryKey)).toBe(true);
    expect(() => parseLibraryKey(randomBytes(12).toString("base64"))).toThrow();
  });
});

describe("integration HLS playlists", () => {
  const unit: HlsUnit = {
    videos: [
      {
        id: "v1",
        quality: "1080p",
        bitrateKbps: 4000,
        width: 1920,
        height: 1080,
        track: { initKey: "media/a/init", codecString: "avc1.640028", segments: [{ key: "media/a/s0", durationSeconds: 6 }] },
      },
    ],
    audio: [
      { id: "a1", language: "eng", label: "English", isDefault: true, track: { initKey: "media/b/init", codecString: "mp4a.40.2", segments: [] } },
      { id: "a2", language: "fre", label: "Français", isDefault: false, track: { initKey: "media/c/init", codecString: "mp4a.40.2", segments: [] } },
    ],
  };

  it("derives segment durations from chunk start times", () => {
    const segments = segmentsFromChunks(
      [
        { key: "k0", sizeBytes: 1, startSeconds: 0 },
        { key: "k1", sizeBytes: 1, startSeconds: 6 },
        { key: "k2", sizeBytes: 1, startSeconds: 13 },
      ],
      20
    );
    expect(segments.map((segment) => segment.durationSeconds)).toEqual([6, 7, 7]);
  });

  it("@req INTG-JF-01[badger-jellyfin] keeps the summed EXTINF equal to the summed durations (lead shifts segments, not the total)", () => {
    const durations = [6.1, 5.9, 4.5];
    const extinf = buildHlsExtinfDurations(durations, 0.25);
    expect(extinf).toHaveLength(3);
    expect(extinf.reduce((sum, value) => sum + value, 0)).toBeCloseTo(16.5, 3);
  });

  it("builds a master playlist with the preferred audio rendition as default", () => {
    const master = buildMasterPlaylist(unit, "http://127.0.0.1:8790/integration/v1/media/m/1080p", "a2");
    expect(master).toContain("#EXT-X-STREAM-INF");
    expect(master).toContain("RESOLUTION=1920x1080");
    const defaultLine = master.split("\n").find((line) => line.includes("DEFAULT=YES"));
    expect(defaultLine).toContain('LANGUAGE="fre"');
  });

  it("builds a track playlist whose object URLs carry the .m4s suffix ffmpeg requires", () => {
    const playlist = buildTrackPlaylist(unit.videos[0].track, "http://127.0.0.1:8790", "video");
    expect(playlist).toContain(`#EXT-X-MAP:URI="${objectUrl("http://127.0.0.1:8790", "media/a/init")}"`);
    expect(playlist).toContain("media%2Fa%2Fs0.m4s");
    expect(playlist.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("integration service config", () => {
  it("@req INTG-JF-03[badger-jellyfin] always binds localhost, whatever the environment says", () => {
    const config = loadIntegrationConfig({ HOST: "0.0.0.0", HEADLESS_HOST: "0.0.0.0", HEADLESS_INTEGRATION_PORT: "9001" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9001);
    expect(config.clientType).toBe("badger-jellyfin");
  });
});

const baseStatus: IntegrationStatus = {
  state: "ok",
  signedIn: true,
  email: "a@b.c",
  userId: "u",
  accessState: "paid",
  paidUntil: null,
  wipeAt: null,
  libraryVersion: 3,
  mediaCount: 0,
  lastSyncAt: null,
  lastError: null,
  apiUrl: "http://api",
  version: "0",
  pairing: null,
  signedOutReason: null,
  keyRejected: false,
  profile: { id: "main-id", name: "Chris", isMain: true },
  profiles: null,
  profileNeeded: null,
};

const fakeDeps = (overrides: Partial<IntegrationDeps> = {}): IntegrationDeps => ({
  getStatus: () => baseStatus,
  isLibraryReady: () => true,
  isStarting: () => false,
  getLibrary: () => ({ version: 3, generatedAt: "now", movies: [], shows: [] }) as never,
  getDetails: () => null,
  objectStore: {
    get: async () => {
      throw Object.assign(new Error("subscription_unpaid"), { status: 402, payload: { wipeAt: "2026-12-01T00:00:00Z" } });
    },
    registerSequence: () => undefined,
    prefetch: () => undefined,
  },
  loadImage: async () => ({ bytes: new Uint8Array(), contentType: "image/png" }),
  recordProgress: async () => undefined,
  getTrackPrefs: () => ({ audioLanguage: null, subtitle: null, updatedAt: null }),
  setTrackPrefs: async () => ({ audioLanguage: null, subtitle: null, updatedAt: null }),
  deleteMedia: async () => ({ deletedKeys: 0, reclaimedBytes: 0 }),
  deleteEpisode: async () => ({ deletedKeys: 0, reclaimedBytes: 0, deletedFile: true }),
  startPairing: async () => {
    throw new Error("not used");
  },
  cancelPairing: () => undefined,
  currentVersion: () => 1,
  waitForChange: async (since) => since,
  login: async () => baseStatus,
  signOut: async () => undefined,
  chooseProfile: async () => baseStatus,
  listProfiles: async () => ({ profile: baseStatus.profile, profiles: [], required: false }),
  streams: { start: async () => ({ status: "play", takeover: false }), poll: () => ({ status: "idle" }), stop: async () => {} },
  log: () => undefined,
  ...overrides,
});

describe("integration HTTP handler", () => {
  it("@req ACCT-UNPAID-03[badger-jellyfin] maps a 402 playback error to subscription_unpaid with wipeAt", async () => {
    const res = await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/object/media%2Fa%2Fb.m4s"), fakeDeps());
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "subscription_unpaid", wipeAt: "2026-12-01T00:00:00Z" });
    expect(errorResponse(new Error("nope")).status).toBe(502);
  });

  it("@req ACCT-UNPAID-03[badger-jellyfin] keeps the library browsable while unpaid", async () => {
    const res = await handleIntegrationRequest(
      new Request("http://127.0.0.1:8790/integration/v1/library"),
      fakeDeps({ getStatus: () => ({ ...baseStatus, accessState: "unpaid", wipeAt: "2026-12-01T00:00:00Z" }) })
    );
    expect(res.status).toBe(200);
  });

  it("answers 503 library_not_ready before the library is open", async () => {
    const res = await handleIntegrationRequest(
      new Request("http://127.0.0.1:8790/integration/v1/library"),
      fakeDeps({ isLibraryReady: () => false })
    );
    expect(res.status).toBe(503);
  });

  it("@req INTG-DEL-01[badger-jellyfin] answers 404 for deleting unknown media and never calls deleteMedia", async () => {
    let called = false;
    const res = await handleIntegrationRequest(
      new Request("http://127.0.0.1:8790/integration/v1/media/missing", { method: "DELETE" }),
      fakeDeps({
        deleteMedia: async () => {
          called = true;
          return { deletedKeys: 0, reclaimedBytes: 0 };
        },
      })
    );
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  describe("remembered tracks", () => {
    const known = { getDetails: () => ({ id: "m" }) as never };
    const post = (body: unknown) =>
      new Request("http://127.0.0.1:8790/integration/v1/tracks", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    it("@req INTG-JF-01[badger-jellyfin] writes only the fields the caller sent", async () => {
      const patches: unknown[] = [];
      const deps = fakeDeps({
        ...known,
        setTrackPrefs: async (_id, patch) => {
          patches.push(patch);
          return { audioLanguage: "fr", subtitle: null, updatedAt: "t" };
        },
      });
      expect((await handleIntegrationRequest(post({ mediaId: "m", audioLanguage: "fr" }), deps)).status).toBe(200);
      expect((await handleIntegrationRequest(post({ mediaId: "m", subtitle: "off" }), deps)).status).toBe(200);
      expect((await handleIntegrationRequest(post({ mediaId: "m", subtitle: { language: "en", format: "srt", forced: false, extra: 1 } }), deps)).status).toBe(200);
      expect(patches).toEqual([
        { audioLanguage: "fr" },
        { subtitle: "off" },
        { subtitle: { language: "en", format: "srt", forced: false } },
      ]);
    });

    it("@req INTG-JF-01[badger-jellyfin] rejects an empty or malformed choice and unknown media without writing", async () => {
      let writes = 0;
      const deps = fakeDeps({ ...known, setTrackPrefs: async () => (writes++, { audioLanguage: null, subtitle: null, updatedAt: null }) });
      expect((await handleIntegrationRequest(post({ mediaId: "m" }), deps)).status).toBe(400);
      expect((await handleIntegrationRequest(post({ mediaId: "m", subtitle: { forced: true } }), deps)).status).toBe(400);
      expect((await handleIntegrationRequest(post({ mediaId: "nope", audioLanguage: "fr" }), fakeDeps({ setTrackPrefs: deps.setTrackPrefs }))).status).toBe(404);
      expect(writes).toBe(0);
    });

    it("@req INTG-JF-01[badger-jellyfin] reads the remembered choice of a movie or show", async () => {
      const deps = fakeDeps({ ...known, getTrackPrefs: () => ({ audioLanguage: "fr", subtitle: "off", updatedAt: "t" }) });
      const res = await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/tracks/m"), deps);
      expect(await res.json()).toEqual({ audioLanguage: "fr", subtitle: "off", updatedAt: "t" });
    });
  });

  it("parses media routes with and without an episode id", () => {
    expect(parseMediaRoute(["m", "1080p", "master.m3u8"])).toEqual({ mediaId: "m", episodeId: null, qualityKey: "1080p", file: "master.m3u8" });
    expect(parseMediaRoute(["m", "e", "auto", "master.m3u8"])).toEqual({ mediaId: "m", episodeId: "e", qualityKey: "auto", file: "master.m3u8" });
    expect(parseMediaRoute(["m"])).toBeNull();
  });
});

describe("integration playable unit subtitles", () => {
  // PLAY-TRACK-05 (OCR twins): Jellyfin is outside that rule's apps, so this test carries no @req tag.
  it("keeps the picture subtitle and drops its OCR twin", () => {
    const subtitle = (fields: Record<string, unknown>) => ({
      mediaId: "m1",
      fileId: "f1",
      episodeId: null,
      language: "fr",
      label: "Français",
      isDefault: false,
      createdAt: "2026-10-29T00:00:00.000Z",
      ...fields,
    });
    const details = {
      id: "m1",
      files: [{ id: "f1", season: null, episode: null }],
      formats: [{ id: "fmt1", mediaId: "m1", fileId: "f1", quality: "1080p", codec: "h264", durationSeconds: 120, chunks: [] }],
      episodes: [],
      audioTracks: [],
      skipMarkers: [],
      subtitleTracks: [
        subtitle({ id: "pgs-fr", format: "sup", objectKey: "fre.sup", source: "ingest", derivedFromSubtitleId: null }),
        subtitle({ id: "pgs-fr-ocr", format: "srt", objectKey: "fre.ocr.srt", source: "ocr", derivedFromSubtitleId: "pgs-fr" }),
      ],
    } as unknown as MediaDetails;
    const unit = resolvePlayableUnit(details, null);
    console.info(`[integration-core:ocr-twin] subtitleIds=${JSON.stringify(unit?.subtitleTracks.map((track) => track.id))}`);
    expect(unit?.subtitleTracks.map((track) => track.id)).toEqual(["pgs-fr"]);
  });
});
