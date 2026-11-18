/**
 * @bugfix @regression-proof gc-deletes-in-flight-ingest (issue #25, PR #86).
 *
 * Desktop-e2e runs 8053, 8068 and 8090 failed `skip-markers:1326` with every
 * video object of the freshly ingested episode answering
 * `TUNNEL_DOWNLOAD_ERROR_download_source_missing`, while the audio objects of
 * the same episode streamed fine. The runtime's one-shot startup storage GC
 * fires 5 s after the first authenticated heartbeat and deletes every
 * badger-owned key the library snapshot does not reference yet. Its only
 * "ingest in progress" guard counted the LEGACY `activeIngestTasks` map, which
 * engineV2 ingestion never populates. So when the sweep landed mid-ingest, a
 * format job's uploaded-but-not-yet-committed objects were swept as orphans,
 * and the commit that followed wrote library rows pointing at deleted
 * objects.
 *
 * The background GC must stand down while engineV2 still has unfinished
 * source/format jobs, exactly as it already does for legacy ingest tasks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySnapshot } from "@space/shared/libraryTypes";
import { BadgerModule } from "../src/modules/badger";

const SUITE = "badger-gc-skips-during-engine-ingest";

// Committed by the source job: referenced by the library snapshot.
const SOURCE_KEYS = [
  "shards/e2e-gw/src-video-init",
  "shards/e2e-gw/src-video-seg-1",
  "shards/e2e-gw/src-audio-init",
  "shards/e2e-gw/src-audio-seg-1",
];
// Uploaded by the 360p format job, whose commit step has not run yet.
const IN_FLIGHT_FORMAT_KEYS = ["shards/e2e-gw/fmt-360p-init", "shards/e2e-gw/fmt-360p-seg-1"];

const snapshot = {
  mediaDetails: [
    {
      formats: [{ initKey: SOURCE_KEYS[0], chunks: [{ key: SOURCE_KEYS[1] }] }],
      audioTracks: [{ initKey: SOURCE_KEYS[2], chunks: [{ key: SOURCE_KEYS[3] }] }],
      subtitleTracks: [],
    },
  ],
};

type GcInternals = { tryBackgroundGc(trigger: "startup" | "interval"): Promise<void> };

describe(`[${SUITE}] background storage GC vs in-flight engineV2 ingest`, () => {
  const mods: BadgerModule[] = [];
  let deletedKeys: string[];
  let gcLogLines: string[];

  beforeEach(() => {
    // No timers: the test drives the sweep directly and awaits it.
    process.env.BADGER_GC_INTERVAL_MS = "0";
    deletedKeys = [];
    gcLogLines = [];
    const allKeys = [...SOURCE_KEYS, ...IN_FLIGHT_FORMAT_KEYS];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        console.info(`[${SUITE}] fetch ${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/storage/objects")) return Response.json({ keys: allKeys });
        if (url.endsWith("/storage/objects/by-app")) {
          // Uploaded long ago, past the GC grace age: only the engine-job
          // guard stands between these objects and the sweep.
          const updatedAt = new Date(Date.now() - 2 * BadgerModule.GC_ORPHAN_GRACE_MS).toISOString();
          return Response.json({ keys: allKeys, objects: allKeys.map((key) => ({ key, updatedAt })) });
        }
        if (url.endsWith("/storage/delete")) {
          const { keys } = JSON.parse(String(init?.body)) as { keys: string[] };
          deletedKeys.push(...keys);
          console.info(`[${SUITE}] /storage/delete keys=${JSON.stringify(keys)}`);
          return Response.json({ deleted: keys.length, reclaimedBytes: 0 });
        }
        if (url.endsWith("/storage/quota/reconcile")) return Response.json({ ok: true });
        throw new Error(`[${SUITE}] unexpected fetch ${url}`);
      }),
    );
    const realLog = console.log;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("badger.storage.gc")) gcLogLines.push(line);
      realLog(...args);
    });
  });

  afterEach(() => {
    for (const mod of mods.splice(0)) mod.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.BADGER_GC_INTERVAL_MS;
  });

  const runSweep = async (unfinishedEngineJobs: number) => {
    const mod = new BadgerModule({ countUnfinishedEngineJobs: async () => unfinishedEngineJobs });
    mods.push(mod);
    mod.setBackendToken("tok-gc-123456");
    vi.spyOn(mod.libraryDbService, "getSnapshot").mockReturnValue(snapshot as unknown as LibrarySnapshot);
    await (mod as unknown as GcInternals).tryBackgroundGc("startup");
    console.info(
      `[${SUITE}] unfinishedEngineJobs=${unfinishedEngineJobs} deleted=${JSON.stringify(deletedKeys)} gcLog=${JSON.stringify(gcLogLines)}`,
    );
  };

  it("does not delete a format job's uploaded-but-uncommitted objects while engineV2 jobs are unfinished", async () => {
    await runSweep(1);
    expect(deletedKeys).toEqual([]);
    expect(gcLogLines.some((l) => l.includes('"reason":"active_engine_jobs"'))).toBe(true);
  });

  it("still reclaims unreferenced objects once no engineV2 job is unfinished", async () => {
    await runSweep(0);
    expect(deletedKeys.sort()).toEqual([...IN_FLIGHT_FORMAT_KEYS].sort());
  });
});
