/**
 * @bugfix @regression-proof storage-stop-wipe (storage audit, 2026-11-11)
 * @req STOR-QUOTA-08
 *
 * On 2026-10-10 a gateway failed during the Badger desktop clean-up. The
 * listing skipped it and answered a partial list; the runtime sent that list
 * as `knownS3Keys` to `/storage/quota/reconcile`, which soft-deleted every
 * record not in it (12,492 records, 21.6 GB still on disk). The runtime also
 * swallowed every reconcile failure silently.
 *
 * The runtime must never hand the API its key list, must stop when the
 * listing fails, and must log a warning when the recount fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySnapshot } from "@space/shared/libraryTypes";
import { BadgerModule } from "../src/modules/badger";

const SUITE = "badger-storage-stop-wipe";

const KEYS = ["shards/gw/init", "shards/gw/seg-1"];
const snapshot = {
  mediaDetails: [{ formats: [{ initKey: KEYS[0], chunks: [{ key: KEYS[1] }] }], audioTracks: [], subtitleTracks: [] }],
};

type GcInternals = { tryBackgroundGc(trigger: "startup" | "interval"): Promise<void> };
type Call = { method: string; url: string; body: string | undefined };

describe(`[${SUITE}] runtime storage clean-up never feeds the API a key list`, () => {
  const mods: BadgerModule[] = [];
  let calls: Call[];
  let warnLines: string[];
  let listing: () => Response;
  let reconcile: () => Promise<Response>;
  let byApp: () => Response;

  beforeEach(() => {
    process.env.BADGER_GC_INTERVAL_MS = "0";
    calls = [];
    warnLines = [];
    listing = () => Response.json({ keys: KEYS });
    byApp = () => {
      const updatedAt = new Date(Date.now() - 2 * BadgerModule.GC_ORPHAN_GRACE_MS).toISOString();
      return Response.json({ keys: KEYS, objects: KEYS.map((key) => ({ key, updatedAt })) });
    };
    reconcile = async () => Response.json({ reconciledBytes: 0, lastReconciledAt: new Date().toISOString() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ method: init?.method ?? "GET", url, body });
        console.info(`[${SUITE}] fetch ${init?.method ?? "GET"} ${url} body=${body ?? "-"}`);
        if (url.endsWith("/storage/objects")) return listing();
        if (url.endsWith("/storage/objects/by-app")) return byApp();
        if (url.endsWith("/storage/delete")) return Response.json({ deleted: 0, reclaimedBytes: 0 });
        if (url.endsWith("/storage/quota/reconcile")) return reconcile();
        throw new Error(`[${SUITE}] unexpected fetch ${url}`);
      }),
    );
    const realWarn = console.warn;
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map(String).join(" "));
      realWarn(...args);
    });
  });

  afterEach(() => {
    for (const mod of mods.splice(0)) mod.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.BADGER_GC_INTERVAL_MS;
  });

  const runSweep = async () => {
    const mod = new BadgerModule({ countUnfinishedEngineJobs: async () => 0 });
    mods.push(mod);
    mod.setBackendToken("tok-gc-123456");
    vi.spyOn(mod.libraryDbService, "getSnapshot").mockReturnValue(snapshot as unknown as LibrarySnapshot);
    await (mod as unknown as GcInternals).tryBackgroundGc("interval");
    console.info(`[${SUITE}] calls=${JSON.stringify(calls)} warnings=${JSON.stringify(warnLines)}`);
  };
  const reconcileCalls = () => calls.filter((c) => c.url.endsWith("/storage/quota/reconcile"));

  it("asks the API for a recount without sending any key list", async () => {
    await runSweep();
    const rec = reconcileCalls();
    expect(rec).toHaveLength(1);
    expect(rec[0].body ?? "").not.toContain("knownS3Keys");
    expect(warnLines).toEqual([]);
  });

  it("a failed listing (502) stops the clean-up: no delete, no reconcile, a warning", async () => {
    listing = () => Response.json({ error: "storage_list_failed", message: "gateway down" }, { status: 502 });
    await runSweep();
    expect(calls.some((c) => c.url.endsWith("/storage/delete"))).toBe(false);
    expect(reconcileCalls()).toHaveLength(0);
    expect(warnLines.some((l) => l.includes("badger.storage.gc.error") && l.includes("502"))).toBe(true);
  });

  // The by-app listing says which keys are Badger's and how old they are. Without it the GC cannot tell Badger's
  // orphans from another app's objects, so that run deletes nothing and warns; the next run tries again.
  const ORPHAN = "shards/gw/unreferenced";
  const byAppFailures: Array<[string, () => Response]> = [
    ["answers 502", () => Response.json({ error: "internal" }, { status: 502 })],
    ["answers 200 without a key list", () => Response.json({ objects: [] })],
  ];
  for (const [label, answer] of byAppFailures) {
    it(`a by-app listing that ${label} stops the clean-up: nothing deleted, a warning`, async () => {
      listing = () => Response.json({ keys: [...KEYS, ORPHAN] });
      byApp = answer;
      await runSweep();
      expect(calls.some((c) => c.url.endsWith("/storage/delete"))).toBe(false);
      expect(warnLines.some((l) => l.includes("badger.storage.gc.error") && l.includes("by-app"))).toBe(true);
    });
  }

  it("control: with the by-app listing up, the same unreferenced old key is deleted", async () => {
    listing = () => Response.json({ keys: [...KEYS, ORPHAN] });
    const updatedAt = new Date(Date.now() - 2 * BadgerModule.GC_ORPHAN_GRACE_MS).toISOString();
    byApp = () => Response.json({ keys: [...KEYS, ORPHAN], objects: [...KEYS, ORPHAN].map((key) => ({ key, updatedAt })) });
    await runSweep();
    const deletes = calls.filter((c) => c.url.endsWith("/storage/delete"));
    expect(deletes.map((c) => c.body ?? "").join(" ")).toContain(ORPHAN);
  });

  it("a reconcile answering 503 logs a warning instead of passing silently", async () => {
    reconcile = async () => Response.json({ error: "no_storage_gateways_available" }, { status: 503 });
    await runSweep();
    expect(warnLines.some((l) => l.includes("badger.storage.reconcile.failed") && l.includes("503"))).toBe(true);
  });

  it("a reconcile that cannot reach the API logs a warning instead of passing silently", async () => {
    reconcile = async () => {
      throw new TypeError("fetch failed");
    };
    await runSweep();
    expect(warnLines.some((l) => l.includes("badger.storage.reconcile.failed") && l.includes("fetch failed"))).toBe(true);
  });
});
