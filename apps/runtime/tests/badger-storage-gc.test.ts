import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import type { RuntimeCommandRequest } from "../src/types";

const SUITE = "badger-storage-gc";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerStorageGcSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    dryRun?: boolean;
    vaultKeys?: unknown;
    badgerOwnedKeys?: unknown;
    referencedKeys?: unknown;
    response?: unknown;
    responseOk?: boolean;
    result?: unknown;
    errorCode?: string;
    abortReason?: string;
    orphanedKeys?: number;
    deletedKeys?: number;
    reclaimedBytes?: number;
    failedKeys?: number;
    missingKeys?: number;
    deleteCalls?: unknown;
    deleteCallCount?: number;
    deleteBodyKeys?: unknown;
    fetchCalls?: unknown;
    fetchCallCount?: number;
    fetchCallUrls?: unknown;
    snapshotMockReturn?: unknown;
    formatKeys?: unknown;
    audioKeys?: unknown;
    subtitleKeys?: unknown;
    runIndex?: number;
    runHistory?: unknown;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-storage-gc snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.dryRun !== undefined) console.error(`dryRun: ${ctx.dryRun}`);
    if (ctx.vaultKeys !== undefined) {
      console.error(`vaultKeys:\n${JSON.stringify(ctx.vaultKeys, jsonReplacer, 2)}`);
    }
    if (ctx.badgerOwnedKeys !== undefined) {
      console.error(`badgerOwnedKeys:\n${JSON.stringify(ctx.badgerOwnedKeys, jsonReplacer, 2)}`);
    }
    if (ctx.referencedKeys !== undefined) {
      console.error(`referencedKeys:\n${JSON.stringify(ctx.referencedKeys, jsonReplacer, 2)}`);
    }
    if (ctx.response !== undefined) {
      console.error(`response:\n${JSON.stringify(ctx.response, jsonReplacer, 2)}`);
    }
    if (ctx.responseOk !== undefined) console.error(`responseOk: ${ctx.responseOk}`);
    if (ctx.result !== undefined) {
      console.error(`result:\n${JSON.stringify(ctx.result, jsonReplacer, 2)}`);
    }
    if (ctx.errorCode !== undefined) console.error(`errorCode: ${ctx.errorCode}`);
    if (ctx.abortReason !== undefined) console.error(`abortReason: ${ctx.abortReason}`);
    if (ctx.orphanedKeys !== undefined) console.error(`orphanedKeys: ${ctx.orphanedKeys}`);
    if (ctx.deletedKeys !== undefined) console.error(`deletedKeys: ${ctx.deletedKeys}`);
    if (ctx.reclaimedBytes !== undefined) console.error(`reclaimedBytes: ${ctx.reclaimedBytes}`);
    if (ctx.failedKeys !== undefined) console.error(`failedKeys: ${ctx.failedKeys}`);
    if (ctx.missingKeys !== undefined) console.error(`missingKeys: ${ctx.missingKeys}`);
    if (ctx.deleteCalls !== undefined) {
      console.error(`deleteCalls:\n${JSON.stringify(ctx.deleteCalls, jsonReplacer, 2)}`);
    }
    if (ctx.deleteCallCount !== undefined) {
      console.error(`deleteCallCount: ${ctx.deleteCallCount}`);
    }
    if (ctx.deleteBodyKeys !== undefined) {
      console.error(`deleteBodyKeys:\n${JSON.stringify(ctx.deleteBodyKeys, jsonReplacer, 2)}`);
    }
    if (ctx.fetchCalls !== undefined) {
      console.error(`fetchCalls:\n${JSON.stringify(ctx.fetchCalls, jsonReplacer, 2)}`);
    }
    if (ctx.fetchCallCount !== undefined) {
      console.error(`fetchCallCount: ${ctx.fetchCallCount}`);
    }
    if (ctx.fetchCallUrls !== undefined) {
      console.error(`fetchCallUrls:\n${JSON.stringify(ctx.fetchCallUrls, jsonReplacer, 2)}`);
    }
    if (ctx.snapshotMockReturn !== undefined) {
      console.error(`snapshotMockReturn:\n${JSON.stringify(ctx.snapshotMockReturn, jsonReplacer, 2)}`);
    }
    if (ctx.formatKeys !== undefined) {
      console.error(`formatKeys:\n${JSON.stringify(ctx.formatKeys, jsonReplacer, 2)}`);
    }
    if (ctx.audioKeys !== undefined) {
      console.error(`audioKeys:\n${JSON.stringify(ctx.audioKeys, jsonReplacer, 2)}`);
    }
    if (ctx.subtitleKeys !== undefined) {
      console.error(`subtitleKeys:\n${JSON.stringify(ctx.subtitleKeys, jsonReplacer, 2)}`);
    }
    if (ctx.runIndex !== undefined) console.error(`runIndex: ${ctx.runIndex}`);
    if (ctx.runHistory !== undefined) {
      console.error(`runHistory:\n${JSON.stringify(ctx.runHistory, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * Helper: open a badger ingest queue so the module has an authenticated session.
 */
const openQueue = async (module: BadgerModule, userId = "gc-user") => {
  await module.execute({
    requestId: "open-gc",
    module: "badger",
    command: "badger.ingest.open",
    payload: {
      userId,
      config: {
        enableCodecSelection: false,
        transcodeOutputs: [{ quality: "360p", codec: "h264" }],
        uiLanguage: "en",
        token: "test-token",
        libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      },
    },
  });
};

/**
 * Helper: execute the GC command and return the parsed result.
 */
const runGc = async (module: BadgerModule, dryRun = false) => {
  const result = await module.execute({
    requestId: `gc-${Date.now()}`,
    module: "badger",
    command: "badger.storage.gc",
    payload: { dryRun },
  });
  return result.response as { ok: boolean; result?: any; error?: any };
};

/**
 * Upload time the by-app stub reports when a test does not set one: well past
 * BadgerModule.GC_ORPHAN_GRACE_MS, so unreferenced keys are reclaimable.
 */
const OLD_UPLOAD_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Helper: build a stub fetch that routes by URL path.
 */
const buildFetchStub = (opts: {
  vaultKeys: string[];
  badgerOwnedKeys?: string[];
  /** Per-key last upload time (ISO); default OLD_UPLOAD_AT. */
  uploadedAtByKey?: Record<string, string>;
  /** Simulate an API that predates `objects` on /storage/objects/by-app. */
  omitOwnedObjectAges?: boolean;
  deleteResponse?: { deleted: number; reclaimedBytes?: number };
  deleteOk?: boolean;
  quotaResponse?: { usageRatio: number };
}) => {
  return vi.fn((url: string, init?: RequestInit) => {
    const urlStr = String(url);
    // Must check /by-app before /storage/objects since the latter is a substring
    if (urlStr.includes("/storage/objects/by-app")) {
      const owned = opts.badgerOwnedKeys ?? opts.vaultKeys;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.omitOwnedObjectAges
              ? { keys: owned }
              : {
                  keys: owned,
                  objects: owned.map((key) => ({ key, updatedAt: opts.uploadedAtByKey?.[key] ?? OLD_UPLOAD_AT })),
                }
          ),
      });
    }
    if (urlStr.includes("/storage/objects")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ keys: opts.vaultKeys }),
      });
    }
    if (urlStr.includes("/storage/delete")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const count = Array.isArray(body.keys) ? body.keys.length : 0;
      return Promise.resolve({
        ok: opts.deleteOk ?? true,
        json: () =>
          Promise.resolve(
            opts.deleteResponse ?? { deleted: count, reclaimedBytes: count * 1024 }
          ),
      });
    }
    if (urlStr.includes("/storage/quota/status")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(opts.quotaResponse ?? { usageRatio: 0.5 }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
};

/**
 * Helper: mock the library snapshot with specific referenced keys.
 */
const mockSnapshot = (
  module: BadgerModule,
  opts: {
    formatKeys?: { initKey?: string; chunks: string[]; previewKeys?: string[] }[];
    audioKeys?: { initKey?: string; chunks: string[] }[];
    subtitleKeys?: string[];
    /** Artwork fields as the library stores them (`asset:<type>::<key>`, a bare key or a catalog path). */
    artwork?: {
      posterPath?: string | null;
      backdropPath?: string | null;
      castProfilePaths?: (string | null)[];
      crewProfilePaths?: (string | null)[];
      seasonPosterPaths?: (string | null)[];
      episodeStillPaths?: (string | null)[];
    };
  }
) => {
  vi.spyOn(module.libraryDbService, "getSnapshot").mockReturnValue({
    media: [],
    playlists: [],
    mediaDetails: [
      {
        id: "media-1",
        title: "Test Movie",
        type: "movie",
        catalogId: 1,
        year: "2024",
        posterPath: opts.artwork?.posterPath ?? null,
        originalLanguage: "en",
        backdropPath: opts.artwork?.backdropPath ?? null,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cast: (opts.artwork?.castProfilePaths ?? []).map((profilePath, i) => ({
          id: `cast-${i}`,
          personId: `person-cast-${i}`,
          catalogId: null,
          name: `Actor ${i}`,
          role: null,
          profilePath,
        })),
        crew: (opts.artwork?.crewProfilePaths ?? []).map((profilePath, i) => ({
          id: `crew-${i}`,
          personId: `person-crew-${i}`,
          catalogId: null,
          name: `Director ${i}`,
          job: "Director",
          profilePath,
        })),
        playlistIds: [],
        seasons: (opts.artwork?.seasonPosterPaths ?? []).map((posterPath, i) => ({
          id: `season-${i}`,
          seasonNumber: i + 1,
          name: `Season ${i + 1}`,
          overview: null,
          posterPath,
          episodeCount: 1,
          airDate: null,
        })),
        episodes: (opts.artwork?.episodeStillPaths ?? []).map((stillPath, i) => ({
          id: `episode-${i}`,
          seasonNumber: 1,
          episodeNumber: i + 1,
          name: `Episode ${i + 1}`,
          overview: null,
          stillPath,
          airDate: null,
        })),
        trailers: [],
        files: [],
        chapters: [],
        skipMarkers: [],
        hasLocalFiles: false,
        formats: (opts.formatKeys ?? []).map((fmt, i) => ({
          id: `fmt-${i}`,
          mediaId: "media-1",
          fileId: "file-1",
          quality: "360p",
          codec: "h264",
          bitrateKbps: 800,
          initKey: fmt.initKey ?? null,
          chunks: fmt.chunks.map((key, ci) => ({ key, index: ci, sizeBytes: 1024 })),
          previewSheets: fmt.previewKeys
            ? {
                version: 1,
                intervalSeconds: 5,
                pictureWidth: 160,
                pictureHeight: 90,
                columns: 10,
                rows: 10,
                pictureCount: fmt.previewKeys.length * 100,
                sheets: fmt.previewKeys.map((objectKey, si) => ({
                  objectKey,
                  sizeBytes: 9_000,
                  firstPicture: si * 100,
                  pictureCount: 100,
                })),
              }
            : undefined,
        })),
        audioTracks: (opts.audioKeys ?? []).map((track, i) => ({
          id: `audio-${i}`,
          mediaId: "media-1",
          fileId: "file-1",
          language: "en",
          label: "English",
          isDefault: i === 0,
          codec: "aac",
          channels: 2,
          objectKey: null,
          initKey: track.initKey ?? null,
          chunks: track.chunks.map((key, ci) => ({ key, index: ci, sizeBytes: 512 })),
        })),
        subtitleTracks: (opts.subtitleKeys ?? []).map((key, i) => ({
          id: `sub-${i}`,
          mediaId: "media-1",
          fileId: null,
          episodeId: null,
          language: "en",
          label: "English",
          isDefault: i === 0,
          codec: "srt",
          objectKey: key,
          sizeBytes: 256,
        })),
      },
    ],
  } as any);
};

describe("badger storage gc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an authenticated session to run GC", async () => {
    const label = "requires-auth";
    console.info(`[${SUITE}:${label}] running GC without opening queue first; expects not_authenticated`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys: [] }));
    const module = new BadgerModule();
    const response = await runGc(module);
    console.info(`[${SUITE}:${label}] response: ok=${response.ok} errorCode=${response.error?.code}`);
    try {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("not_authenticated");
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        response,
        responseOk: response.ok,
        errorCode: response.error?.code,
        expected: { ok: false, errorCode: "not_authenticated" },
        actual: { ok: response.ok, errorCode: response.error?.code },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("reports zero orphaned keys when vault matches library exactly", async () => {
    const label = "zero-orphans-exact-match";
    const referencedKeys = ["video-init-1", "seg-001", "seg-002", "audio-init-1", "audio-001", "sub-en.srt"];
    console.info(`[${SUITE}:${label}] vault=library exactly; expects orphans=0 deleted=0 missing=0`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys: referencedKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ initKey: "video-init-1", chunks: ["seg-001", "seg-002"] }],
      audioKeys: [{ initKey: "audio-init-1", chunks: ["audio-001"] }],
      subtitleKeys: ["sub-en.srt"],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        orphanedKeys: 0,
        deletedKeys: 0,
        reclaimedBytes: 0,
        missingKeys: 0,
      });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys: referencedKeys,
        referencedKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, missingKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("@req MPV-PREV-02 keeps the seek-bar preview sheets a format references", async () => {
    const label = "keeps-preview-sheets";
    const vaultKeys = ["video-init-1", "seg-001", "preview-sheet-0", "preview-sheet-1", "orphan-a"];
    console.info(`[${SUITE}:${label}] vault has 2 referenced preview sheets + 1 orphan; expects orphans=1`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ initKey: "video-init-1", chunks: ["seg-001"], previewKeys: ["preview-sheet-0", "preview-sheet-1"] }],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 0, missingKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 1, deletedKeys: 0, missingKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("identifies orphaned keys not referenced by library in dry-run mode", async () => {
    const label = "dry-run-identifies-orphans";
    const vaultKeys = ["seg-001", "seg-002", "orphan-a", "orphan-b", "sub-en.srt"];
    console.info(`[${SUITE}:${label}] vault=5 keys, 2 orphans (a,b); expects orphans=2, no deletion in dry-run`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001", "seg-002"] }],
      subtitleKeys: ["sub-en.srt"],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        orphanedKeys: 2,
        deletedKeys: 0,
        reclaimedBytes: 0,
      });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 2, deletedKeys: 0, reclaimedBytes: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("deletes orphaned keys and reclaims storage when not in dry-run mode", async () => {
    const label = "deletes-orphans-not-dry";
    // Keep orphan ratio <=50%: 8 vault keys, 3 orphans = 37.5%
    const vaultKeys = ["seg-001", "seg-002", "seg-003", "seg-004", "seg-005", "orphan-a", "orphan-b", "orphan-c"];
    console.info(`[${SUITE}:${label}] vault=8 keys, 3 orphans (37.5%); expects deletion of orphan-a/b/c with 3072 reclaimed`);
    const fetchStub = buildFetchStub({
      vaultKeys,
      deleteResponse: { deleted: 3, reclaimedBytes: 3072 },
    });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001", "seg-002", "seg-003", "seg-004", "seg-005"] }],
    });

    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        orphanedKeys: 3,
        deletedKeys: 3,
        reclaimedBytes: 3072,
        failedKeys: 0,
      });

      // Verify the delete API was called with the orphaned keys
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      const deleteBody = JSON.parse(String(deleteCalls[0][1]?.body));
      expect(deleteBody.keys).toEqual(expect.arrayContaining(["orphan-a", "orphan-b", "orphan-c"]));
      expect(deleteBody.keys).not.toContain("seg-001");
    } catch (err) {
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      const deleteBodyKeys = deleteCalls[0]?.[1]
        ? (() => { try { return JSON.parse(String((deleteCalls[0][1] as RequestInit)?.body)).keys; } catch { return "(parse-fail)"; } })()
        : undefined;
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        deleteCallCount: deleteCalls.length,
        deleteBodyKeys,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { orphanedKeys: 3, deletedKeys: 3, reclaimedBytes: 3072, failedKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("@req STOR-PLACE-08[runtime,badger-desktop] @bugfix @regression-proof keeps a live media's artwork past the grace age and still deletes artwork no media uses", async () => {
    const label = "keeps-live-artwork";
    // Shapes copied from the dev library on 2026-11-11: artwork rows hold `asset:image/jpeg::<key>`, the vault
    // lists the bare `shards/<pool>/assets/<uuid>` key. Every key is 30 days old, past the grace age.
    const art = (name: string) => `shards/pool-a/assets/${name}`;
    const liveArtworkKeys = [
      art("poster.jpg"),
      art("backdrop.jpg"),
      art("cast.jpg"),
      art("crew.jpg"),
      art("season.jpg"),
      art("still.jpg"),
    ];
    const orphanArtworkKey = art("orphan-poster.jpg");
    const segmentKeys = Array.from({ length: 8 }, (_, i) => `media/p1/seg-${i}`);
    const vaultKeys = [...segmentKeys, ...liveArtworkKeys, orphanArtworkKey];
    console.info(
      `[${SUITE}:${label}] vault=${vaultKeys.length} keys: ${segmentKeys.length} segments, ${liveArtworkKeys.length} live artwork, 1 orphan artwork; expects only ${orphanArtworkKey} deleted`
    );
    const fetchStub = buildFetchStub({ vaultKeys, deleteResponse: { deleted: 1, reclaimedBytes: 1024 } });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: segmentKeys }],
      artwork: {
        posterPath: `asset:image/jpeg::${art("poster.jpg")}`,
        backdropPath: `asset:image/jpeg::${art("backdrop.jpg")}`,
        castProfilePaths: [`asset:image/jpeg::${art("cast.jpg")}`, "/catalogOnlyActor.jpg", null],
        crewProfilePaths: [art("crew.jpg")],
        seasonPosterPaths: [`asset:image/jpeg::${art("season.jpg")}`, "/catalogSeason.jpg"],
        episodeStillPaths: [`asset:image/jpeg::${art("still.jpg")}`, "https://example.test/still.jpg"],
      },
    });

    const response = await runGc(module, false);
    const deleteCalls = fetchStub.mock.calls.filter(([url]: [string, ...unknown[]]) =>
      String(url).includes("/storage/delete")
    );
    const deletedKeys: string[] = deleteCalls.flatMap((call) => {
      try {
        return JSON.parse(String((call[1] as RequestInit | undefined)?.body)).keys ?? [];
      } catch {
        return ["(parse-fail)"];
      }
    });
    console.info(
      `[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)} deleteCalls=${deleteCalls.length} deletedKeys=${JSON.stringify(deletedKeys)}`
    );
    try {
      expect(response.ok).toBe(true);
      expect(deletedKeys).toEqual([orphanArtworkKey]);
      for (const key of liveArtworkKeys) expect(deletedKeys).not.toContain(key);
      // Catalog paths and URLs are not storage pieces: never counted as missing.
      expect(response.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 1, missingKeys: 0, failedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        referencedKeys: [...segmentKeys, ...liveArtworkKeys],
        response,
        responseOk: response.ok,
        result: response.result,
        deleteCallCount: deleteCalls.length,
        deleteBodyKeys: deletedKeys,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { deletedKeys: [orphanArtworkKey], orphanedKeys: 1, missingKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("preserves library/ and dummy_ prefixed keys even if unreferenced", async () => {
    const label = "preserves-library-and-dummy-prefixes";
    const vaultKeys = ["seg-001", "library/manifest.enc", "library/snapshot-v3.enc", "dummy_test_obj", "orphan-x"];
    console.info(`[${SUITE}:${label}] vault has library/* + dummy_* + orphan-x; expects only orphan-x identified`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      // Only orphan-x should be identified; library/ and dummy_ keys are protected
      expect(response.result).toMatchObject({ orphanedKeys: 1 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 1 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // Silo-pinned library objects are written as `shards/<shardId>/library/...` (seen in the
  // storage-hygiene e2e: manifests, ops, chunks). Treating only a bare `library/` prefix as
  // protected let a real GC delete the user's library once the ledger rows aged past grace.
  it("preserves shard-prefixed library objects (shards/<id>/library/...) even if unreferenced", async () => {
    const label = "preserves-shard-prefixed-library";
    const vaultKeys = [
      "seg-001",
      "shards/e2e-gw/library/badger/manifests/m-1",
      "shards/e2e-gw/library/badger/ops/op-1",
      "shards/e2e-gw/library/chunks/c-1",
      "orphan-x",
    ];
    console.info(`[${SUITE}:${label}] vault has shards/<id>/library/* + orphan-x; expects only orphan-x identified`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 1 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 1 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("reports missing keys that library references but vault does not contain", async () => {
    const label = "reports-missing-keys";
    const vaultKeys = ["seg-001"];
    console.info(`[${SUITE}:${label}] vault has seg-001 only; library references 4 keys; expects missing=3 orphans=0`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ initKey: "video-init-1", chunks: ["seg-001", "seg-002"] }],
      subtitleKeys: ["sub-en.srt"],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      // video-init-1, seg-002, and sub-en.srt are referenced but missing from vault
      expect(response.result).toMatchObject({ missingKeys: 3, orphanedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { missingKeys: 3, orphanedKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("tracks failed delete attempts and retries on subsequent GC runs", async () => {
    const label = "tracks-failed-retries";
    const vaultKeys = ["seg-001", "orphan-fail"];
    console.info(`[${SUITE}:${label}] run1=fail run2=succeed; expects first failedKeys=1 then deletedKeys=1`);
    // First run: delete fails
    const failFetch = buildFetchStub({ vaultKeys, deleteOk: false });
    vi.stubGlobal("fetch", failFetch);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    console.info(`[${SUITE}:${label}] run1: dispatching GC with failing delete stub`);
    const first = await runGc(module, false);
    console.info(`[${SUITE}:${label}] run1 result=${JSON.stringify(first.result)}`);
    try {
      expect(first.ok).toBe(true);
      expect(first.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 0, failedKeys: 1 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        runIndex: 1,
        vaultKeys,
        response: first,
        responseOk: first.ok,
        result: first.result,
        expected: { orphanedKeys: 1, deletedKeys: 0, failedKeys: 1 },
        actual: first.result,
        error: err,
      });
      throw err;
    }

    // Second run: delete succeeds
    const successFetch = buildFetchStub({
      vaultKeys,
      deleteOk: true,
      deleteResponse: { deleted: 1, reclaimedBytes: 512 },
    });
    vi.stubGlobal("fetch", successFetch);

    console.info(`[${SUITE}:${label}] run2: dispatching GC with success delete stub`);
    const second = await runGc(module, false);
    console.info(`[${SUITE}:${label}] run2 result=${JSON.stringify(second.result)}`);
    try {
      expect(second.ok).toBe(true);
      expect(second.result).toMatchObject({ deletedKeys: 1, reclaimedBytes: 512, failedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        runIndex: 2,
        vaultKeys,
        response: second,
        responseOk: second.ok,
        result: second.result,
        runHistory: [{ run: 1, result: first.result }, { run: 2, result: second.result }],
        expected: { deletedKeys: 1, reclaimedBytes: 512, failedKeys: 0 },
        actual: second.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("stops retrying keys after 3 consecutive failures", async () => {
    const label = "stops-after-3-failures";
    const vaultKeys = ["seg-001", "persistent-orphan"];
    console.info(`[${SUITE}:${label}] persistent-orphan; expects 3 failed-retry rounds then dropped on round 4`);
    const failFetch = buildFetchStub({ vaultKeys, deleteOk: false });
    vi.stubGlobal("fetch", failFetch);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const runHistory: Array<{ run: number; result: unknown }> = [];
    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      console.info(`[${SUITE}:${label}] run ${i + 1}/3: dispatching GC (expected failedKeys=1)`);
      const res = await runGc(module, false);
      runHistory.push({ run: i + 1, result: res.result });
      console.info(`[${SUITE}:${label}] run ${i + 1} result=${JSON.stringify(res.result)}`);
      try {
        expect(res.ok).toBe(true);
        expect(res.result?.failedKeys).toBe(1);
      } catch (err) {
        dumpBadgerStorageGcSnapshot(label, {
          runIndex: i + 1,
          vaultKeys,
          response: res,
          responseOk: res.ok,
          result: res.result,
          runHistory,
          expected: { failedKeys: 1 },
          actual: { failedKeys: res.result?.failedKeys },
          error: err,
        });
        throw err;
      }
    }

    // 4th run: key should no longer appear as orphaned (dropped after 3 failures)
    console.info(`[${SUITE}:${label}] run 4: key should be dropped now; expects orphans=0 failed=0`);
    const res = await runGc(module, false);
    runHistory.push({ run: 4, result: res.result });
    console.info(`[${SUITE}:${label}] run 4 result=${JSON.stringify(res.result)}`);
    try {
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ orphanedKeys: 0, failedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        runIndex: 4,
        vaultKeys,
        response: res,
        responseOk: res.ok,
        result: res.result,
        runHistory,
        expected: { orphanedKeys: 0, failedKeys: 0 },
        actual: res.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("handles empty vault gracefully", async () => {
    const label = "empty-vault-graceful";
    console.info(`[${SUITE}:${label}] empty vault, library references seg-001; expects orphans=0 missing=1`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys: [] }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 0, missingKeys: 1 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys: [],
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 0, missingKeys: 1 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("aborts GC when library DB is not open (snapshot is null) to prevent data loss", async () => {
    const label = "aborts-snapshot-null";
    const vaultKeys = ["orphan-a", "orphan-b", "library/manifest.enc"];
    console.info(`[${SUITE}:${label}] snapshot=null; GC must abort to prevent data loss (no delete calls)`);
    const fetchStub = buildFetchStub({ vaultKeys });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    vi.spyOn(module.libraryDbService, "getSnapshot").mockReturnValue(null);

    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      // GC must abort — cannot determine referenced keys without snapshot
      expect(response.result).toMatchObject({ orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0 });
      // Verify no delete calls were made
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      expect(deleteCalls).toHaveLength(0);
    } catch (err) {
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        snapshotMockReturn: null,
        response,
        responseOk: response.ok,
        result: response.result,
        deleteCallCount: deleteCalls.length,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, deleteCallCount: 0 },
        actual: { ...response.result, deleteCallCount: deleteCalls.length },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("aborts GC when snapshot exists but referenced set is empty while storage has objects", async () => {
    const label = "aborts-empty-referenced-set";
    const vaultKeys = ["file-a", "file-b", "file-c"];
    console.info(`[${SUITE}:${label}] empty referenced set + 3 vault keys; GC must abort (no delete calls)`);
    const fetchStub = buildFetchStub({ vaultKeys });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    // Snapshot exists but has no media with referenced keys
    const emptySnapshot = { media: [], playlists: [], mediaDetails: [] };
    vi.spyOn(module.libraryDbService, "getSnapshot").mockReturnValue(emptySnapshot as any);

    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0 });
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      expect(deleteCalls).toHaveLength(0);
    } catch (err) {
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        snapshotMockReturn: emptySnapshot,
        response,
        responseOk: response.ok,
        result: response.result,
        deleteCallCount: deleteCalls.length,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, deleteCallCount: 0 },
        actual: { ...response.result, deleteCallCount: deleteCalls.length },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("aborts when orphan ratio exceeds safety cap (>50% of vault)", async () => {
    const label = "aborts-ratio-exceeded";
    // 4 objects in vault, 3 are orphaned = 75% deletion ratio → should abort
    const vaultKeys = ["seg-001", "orphan-a", "orphan-b", "orphan-c"];
    console.info(`[${SUITE}:${label}] 4 vault, 3 orphans=75%; expects abort with abortReason=delete_ratio_exceeded*`);
    const fetchStub = buildFetchStub({ vaultKeys });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 3, deletedKeys: 0, reclaimedBytes: 0 });
      expect(response.result?.abortReason).toMatch(/^delete_ratio_exceeded/);
      // Verify no delete calls were made
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      expect(deleteCalls).toHaveLength(0);
    } catch (err) {
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        abortReason: response.result?.abortReason,
        deleteCallCount: deleteCalls.length,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { orphanedKeys: 3, deletedKeys: 0, reclaimedBytes: 0, abortReasonMatches: "^delete_ratio_exceeded", deleteCallCount: 0 },
        actual: { ...response.result, deleteCallCount: deleteCalls.length },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("allows deletion when orphan ratio is within safety cap (<=50%)", async () => {
    const label = "allows-ratio-within-cap";
    // 4 objects in vault, 1 is orphaned = 25% → should proceed
    const vaultKeys = ["seg-001", "seg-002", "seg-003", "orphan-a"];
    console.info(`[${SUITE}:${label}] 4 vault, 1 orphan=25%; expects deletion ok=true, no abortReason`);
    const fetchStub = buildFetchStub({
      vaultKeys,
      deleteResponse: { deleted: 1, reclaimedBytes: 1024 },
    });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001", "seg-002", "seg-003"] }],
    });

    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 1 });
      expect(response.result?.abortReason).toBeUndefined();
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        abortReason: response.result?.abortReason,
        expected: { orphanedKeys: 1, deletedKeys: 1, abortReason: undefined },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("reports orphan count in dry-run even when ratio would exceed cap", async () => {
    const label = "dry-run-reports-orphans-over-cap";
    // Dry-run should still report the orphan count for diagnostics
    const vaultKeys = ["seg-001", "orphan-a", "orphan-b", "orphan-c"];
    console.info(`[${SUITE}:${label}] dry-run with 75% orphan ratio; expects orphan count reported despite cap`);
    vi.stubGlobal("fetch", buildFetchStub({ vaultKeys }));
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    const response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] response ok=${response.ok} result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      // Dry-run returns before the ratio check, so orphanedKeys is reported
      expect(response.result).toMatchObject({ orphanedKeys: 3, deletedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        expected: { orphanedKeys: 3, deletedKeys: 0 },
        actual: response.result,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("only deletes badger-owned orphans, never touches other apps' objects", async () => {
    const label = "only-deletes-badger-owned";
    // Vault has badger + parrot keys mixed together
    const vaultKeys = ["seg-001", "badger-orphan", "parrot-file-a", "parrot-file-b", "library/manifest.enc"];
    // Only seg-001 and badger-orphan are badger-owned in the DB
    const badgerOwnedKeys = ["seg-001", "badger-orphan"];
    console.info(`[${SUITE}:${label}] mixed vault (badger+parrot+library); only badger-owned orphans must be deleted`);
    const fetchStub = buildFetchStub({
      vaultKeys,
      badgerOwnedKeys,
      deleteResponse: { deleted: 1, reclaimedBytes: 1024 },
    });
    vi.stubGlobal("fetch", fetchStub);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["seg-001"] }],
    });

    // Dry run: only badger-orphan should be identified, not parrot files
    console.info(`[${SUITE}:${label}] phase=dry-run`);
    const dryResponse = await runGc(module, true);
    console.info(`[${SUITE}:${label}] dry-run result=${JSON.stringify(dryResponse.result)}`);
    try {
      expect(dryResponse.ok).toBe(true);
      expect(dryResponse.result).toMatchObject({ orphanedKeys: 1 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: true,
        vaultKeys,
        badgerOwnedKeys,
        response: dryResponse,
        responseOk: dryResponse.ok,
        result: dryResponse.result,
        expected: { orphanedKeys: 1 },
        actual: dryResponse.result,
        error: err,
      });
      throw err;
    }

    // Actual run: verify only badger-orphan is deleted
    console.info(`[${SUITE}:${label}] phase=actual-run`);
    const response = await runGc(module, false);
    console.info(`[${SUITE}:${label}] actual-run result=${JSON.stringify(response.result)}`);
    try {
      expect(response.ok).toBe(true);
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      expect(deleteCalls.length).toBe(1);
      const deleteBody = JSON.parse(String(deleteCalls[0][1]?.body));
      expect(deleteBody.keys).toEqual(["badger-orphan"]);
      expect(deleteBody.keys).not.toContain("parrot-file-a");
      expect(deleteBody.keys).not.toContain("parrot-file-b");
    } catch (err) {
      const deleteCalls = fetchStub.mock.calls.filter(
        ([url]: [string, ...unknown[]]) => String(url).includes("/storage/delete")
      );
      const deleteBodyKeys = deleteCalls[0]?.[1]
        ? (() => { try { return JSON.parse(String((deleteCalls[0][1] as RequestInit)?.body)).keys; } catch { return "(parse-fail)"; } })()
        : undefined;
      dumpBadgerStorageGcSnapshot(label, {
        dryRun: false,
        vaultKeys,
        badgerOwnedKeys,
        response,
        responseOk: response.ok,
        result: response.result,
        deleteCallCount: deleteCalls.length,
        deleteBodyKeys,
        fetchCallUrls: fetchStub.mock.calls.map((c) => String(c[0])),
        expected: { deleteCallCount: 1, deleteBodyKeys: ["badger-orphan"], excluded: ["parrot-file-a", "parrot-file-b"] },
        actual: { deleteCallCount: deleteCalls.length, deleteBodyKeys },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("prevents concurrent GC runs", async () => {
    const label = "prevents-concurrent-runs";
    console.info(`[${SUITE}:${label}] gc1 blocks on list; gc2 must short-circuit to zeros while gc1 in flight`);
    // Use a fetch that delays the list response
    const pendingResolvers: Array<() => void> = [];
    const delayedFetch = vi.fn((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/storage/objects/by-app")) {
        return new Promise((resolve) => {
          pendingResolvers.push(() =>
            resolve({ ok: true, json: () => Promise.resolve({ keys: ["orphan"], objects: [{ key: "orphan", updatedAt: OLD_UPLOAD_AT }] }) })
          );
        });
      }
      if (urlStr.includes("/storage/objects")) {
        return new Promise((resolve) => {
          pendingResolvers.push(() =>
            resolve({ ok: true, json: () => Promise.resolve({ keys: ["orphan"] }) })
          );
        });
      }
      if (urlStr.includes("/storage/quota/status")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ usageRatio: 0 }) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deleted: 1, reclaimedBytes: 100 }),
      });
    });
    vi.stubGlobal("fetch", delayedFetch);
    const module = new BadgerModule();
    await openQueue(module);
    mockSnapshot(module, {
      formatKeys: [{ chunks: ["referenced-key"] }],
    });

    // Start first GC (will block on list)
    console.info(`[${SUITE}:${label}] starting gc1 (will block on list fetch)`);
    const gc1 = runGc(module, true);
    // Start second GC concurrently — should return zeros immediately
    console.info(`[${SUITE}:${label}] starting gc2 (concurrent; expects immediate zeros)`);
    const gc2Response = await runGc(module, true);
    console.info(`[${SUITE}:${label}] gc2 result=${JSON.stringify(gc2Response.result)} pendingResolvers=${pendingResolvers.length}`);
    try {
      expect(gc2Response.ok).toBe(true);
      expect(gc2Response.result).toMatchObject({ orphanedKeys: 0, deletedKeys: 0 });
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        runIndex: 2,
        response: gc2Response,
        responseOk: gc2Response.ok,
        result: gc2Response.result,
        extra: { pendingResolversCount: pendingResolvers.length },
        expected: { orphanedKeys: 0, deletedKeys: 0 },
        actual: gc2Response.result,
        error: err,
      });
      throw err;
    }

    // Resolve all pending fetches for the first GC
    console.info(`[${SUITE}:${label}] resolving ${pendingResolvers.length} pending list fetches for gc1`);
    for (const resolve of pendingResolvers) resolve();
    const gc1Response = await gc1;
    console.info(`[${SUITE}:${label}] gc1 result=${JSON.stringify(gc1Response.result)}`);
    try {
      expect(gc1Response.ok).toBe(true);
      expect(gc1Response.result?.orphanedKeys).toBe(1);
    } catch (err) {
      dumpBadgerStorageGcSnapshot(label, {
        runIndex: 1,
        response: gc1Response,
        responseOk: gc1Response.ok,
        result: gc1Response.result,
        fetchCallUrls: delayedFetch.mock.calls.map((c) => String(c[0])),
        expected: { orphanedKeys: 1 },
        actual: { orphanedKeys: gc1Response.result?.orphanedKeys },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // Issue #25 P16: an engineV2 format job uploads its objects long before its
  // commit step references them. Every deleting GC path must leave young
  // unreferenced objects alone, and objects whose age it cannot know.
  describe("@bugfix @regression-proof grace age and engine guard (issue #25 P16)", () => {
    const deleteBodies = (fetchStub: { mock: { calls: Array<[string, RequestInit?]> } }) =>
      fetchStub.mock.calls
        .filter(([url]) => String(url).includes("/storage/delete"))
        .flatMap(([, init]) => (JSON.parse(String(init?.body ?? "{}")).keys ?? []) as string[]);

    it("never deletes an unreferenced object uploaded within the grace age", async () => {
      const label = "grace-protects-young";
      const now = Date.now();
      const vaultKeys = ["seg-001", "seg-002", "seg-003", "seg-004", "old-orphan", "fresh-upload", "edge-upload"];
      const uploadedAtByKey = {
        "fresh-upload": new Date(now - 60_000).toISOString(),
        // One minute short of the grace age: still protected.
        "edge-upload": new Date(now - BadgerModule.GC_ORPHAN_GRACE_MS + 60_000).toISOString(),
      };
      const fetchStub = buildFetchStub({ vaultKeys, uploadedAtByKey });
      vi.stubGlobal("fetch", fetchStub);
      const module = new BadgerModule();
      await openQueue(module);
      mockSnapshot(module, { formatKeys: [{ chunks: ["seg-001", "seg-002", "seg-003", "seg-004"] }] });

      const response = await runGc(module, false);
      const deleted = deleteBodies(fetchStub);
      console.info(`[${SUITE}:${label}] graceMs=${BadgerModule.GC_ORPHAN_GRACE_MS} result=${JSON.stringify(response.result)} deleted=${JSON.stringify(deleted)}`);
      try {
        expect(BadgerModule.GC_ORPHAN_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(response.ok).toBe(true);
        expect(deleted).toEqual(["old-orphan"]);
        expect(response.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 1, graceProtectedKeys: 2 });
      } catch (err) {
        dumpBadgerStorageGcSnapshot(label, {
          dryRun: false,
          vaultKeys,
          result: response.result,
          deleteBodyKeys: deleted,
          expected: { deleted: ["old-orphan"], orphanedKeys: 1, graceProtectedKeys: 2 },
          actual: { deleted, ...response.result },
          extra: { uploadedAtByKey },
          error: err,
        });
        throw err;
      }
      module.shutdown();
    });

    it("deletes nothing when the API does not report upload times", async () => {
      const label = "grace-unknown-age-protected";
      const vaultKeys = ["seg-001", "seg-002", "seg-003", "orphan-a"];
      const fetchStub = buildFetchStub({ vaultKeys, omitOwnedObjectAges: true });
      vi.stubGlobal("fetch", fetchStub);
      const module = new BadgerModule();
      await openQueue(module);
      mockSnapshot(module, { formatKeys: [{ chunks: ["seg-001", "seg-002", "seg-003"] }] });

      const response = await runGc(module, false);
      const deleted = deleteBodies(fetchStub);
      console.info(`[${SUITE}:${label}] result=${JSON.stringify(response.result)} deleted=${JSON.stringify(deleted)}`);
      try {
        expect(response.ok).toBe(true);
        expect(deleted).toEqual([]);
        expect(response.result).toMatchObject({ orphanedKeys: 0, deletedKeys: 0, graceProtectedKeys: 1 });
      } catch (err) {
        dumpBadgerStorageGcSnapshot(label, { dryRun: false, vaultKeys, result: response.result, deleteBodyKeys: deleted, error: err });
        throw err;
      }
      module.shutdown();
    });

    it("the user-triggered badger.storage.gc deletes nothing while engineV2 jobs are unfinished, or when their count is unreadable", async () => {
      const label = "manual-gc-engine-guard";
      const vaultKeys = ["seg-001", "seg-002", "seg-003", "old-orphan"];
      for (const [count, expectedReason] of [
        [async () => 2, "active_engine_jobs"],
        [async (): Promise<number> => { throw new Error("runtime_jobs.db locked"); }, "engine_jobs_unknown"],
      ] as const) {
        const fetchStub = buildFetchStub({ vaultKeys });
        vi.stubGlobal("fetch", fetchStub);
        const module = new BadgerModule({ countUnfinishedEngineJobs: count });
        await openQueue(module);
        mockSnapshot(module, { formatKeys: [{ chunks: ["seg-001", "seg-002", "seg-003"] }] });

        const dry = await runGc(module, true);
        const response = await runGc(module, false);
        const deleted = deleteBodies(fetchStub);
        console.info(
          `[${SUITE}:${label}] expectedReason=${expectedReason} dry=${JSON.stringify(dry.result)} result=${JSON.stringify(response.result)} deleted=${JSON.stringify(deleted)}`,
        );
        try {
          // Dry run still reports what it would reclaim.
          expect(dry.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 0 });
          expect(response.ok).toBe(true);
          expect(deleted).toEqual([]);
          expect(response.result).toMatchObject({ orphanedKeys: 1, deletedKeys: 0, abortReason: expectedReason });
        } catch (err) {
          dumpBadgerStorageGcSnapshot(label, {
            dryRun: false,
            vaultKeys,
            result: response.result,
            abortReason: response.result?.abortReason,
            deleteBodyKeys: deleted,
            expected: { deleted: [], abortReason: expectedReason },
            actual: { deleted, ...response.result },
            error: err,
          });
          throw err;
        }
        module.shutdown();
        vi.unstubAllGlobals();
      }
    });
  });
});
