import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryOpEntry } from "@space/shared/contracts/library";
import { fetchOpPayloads } from "@space/mobile-shell/libraryOps";

/**
 * @test-id MOBILE-OPS-FETCH-001
 * @level integration
 * @bugfix
 * @regression-proof Mobile syncFromRemoteIfNewer used `fetch(entry.downloadUrl)` but the
 *   server (the API's `GET /library/db/ops`) returns ops with `objectKey`, not
 *   `downloadUrl`. fetch(undefined) produced "Network request failed" in an infinite SSE
 *   sync loop. This locks in the desktop pattern (packages/library-db-runtime/src/libraryDb.ts:6021)
 *   for the mobile op-fetch helper: download via storage tunnel, keyed by objectKey, never
 *   raw fetch.
 */

const stubFetch = vi.fn(() => {
  throw new Error("regression: raw fetch must not be called for op payloads");
});
vi.stubGlobal("fetch", stubFetch);

afterEach(() => {
  stubFetch.mockClear();
});

const makeEntry = (overrides: Partial<LibraryOpEntry> = {}): LibraryOpEntry => ({
  opId: "op-1",
  version: 1,
  createdAt: "2026-05-07T20:00:00.000Z",
  size: 16,
  objectKey: "library/badger/users/abc/ops/op-1",
  ...overrides,
});

const okOp = JSON.stringify({ type: "noop", id: "x" });

// On assertion failure, dump the spy call counts/args + captured events so an
// op-fetch path regression is diagnosable from CI logs alone. Wrapped in
// try/catch so a dump failure can never mask the original assertion error.
const dumpOpsFetchSnapshot = (
  label: string,
  ctx: {
    download?: ReturnType<typeof vi.fn>;
    decrypt?: ReturnType<typeof vi.fn>;
    decode?: ReturnType<typeof vi.fn>;
    downloaded?: string[];
    events?: Array<{ event: string; data: Record<string, unknown> }>;
    result?: unknown;
  },
) => {
  try {
    console.error(`=== [library-ops-fetch-integration:${label}] snapshot ===`);
    if (ctx.download) console.error(`download: calls=${ctx.download.mock.calls.length} keys=${JSON.stringify(ctx.download.mock.calls.map((c) => c[0]))}`);
    if (ctx.decrypt) console.error(`decrypt: calls=${ctx.decrypt.mock.calls.length}`);
    if (ctx.decode) console.error(`decode: calls=${ctx.decode.mock.calls.length}`);
    if (ctx.downloaded) console.error(`downloaded order=${JSON.stringify(ctx.downloaded)}`);
    console.error(`stubFetch (raw): calls=${stubFetch.mock.calls.length}`);
    if (ctx.events) console.error(`events:\n${JSON.stringify(ctx.events, null, 2)}`);
    if (ctx.result !== undefined) console.error(`result:\n${JSON.stringify(ctx.result, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("fetchOpPayloads", () => {
  it("downloads each op via injected download fn keyed by objectKey", async () => {
    console.info("[library-ops-fetch-integration:download-keyed] fetching 2 ops via injected download fn");
    const downloaded: string[] = [];
    const ops = [
      makeEntry({ opId: "a", version: 1, objectKey: "library/badger/users/u/ops/a" }),
      makeEntry({ opId: "b", version: 2, objectKey: "library/badger/users/u/ops/b" }),
    ];
    const download = vi.fn(async (key: string) => {
      downloaded.push(key);
      return new Uint8Array([0x42]);
    });
    const decrypt = vi.fn(async (bytes: Uint8Array) => bytes);
    const decode = vi.fn(() => okOp);

    const result = await fetchOpPayloads(ops, { download, decrypt, decode });
    console.info(`[library-ops-fetch-integration:download-keyed] result.length=${result.length} download.calls=${download.mock.calls.length} downloaded=${JSON.stringify(downloaded)}`);

    try {
      expect(result).toHaveLength(2);
      expect(download).toHaveBeenCalledTimes(2);
      expect(downloaded).toEqual([
        "library/badger/users/u/ops/a",
        "library/badger/users/u/ops/b",
      ]);
    } catch (err) {
      dumpOpsFetchSnapshot("download-keyed-mismatch", { download, decrypt, decode, downloaded, result });
      throw err;
    }
  });

  it("never calls raw global fetch for op payloads", async () => {
    console.info("[library-ops-fetch-integration:no-raw-fetch] fetching op — raw global fetch must NOT be hit");
    const ops = [makeEntry()];
    const download = vi.fn(async () => new Uint8Array([0]));
    const decrypt = vi.fn(async (b: Uint8Array) => b);
    const decode = vi.fn(() => okOp);

    await fetchOpPayloads(ops, { download, decrypt, decode });
    console.info(`[library-ops-fetch-integration:no-raw-fetch] stubFetch.calls=${stubFetch.mock.calls.length} download.calls=${download.mock.calls.length}`);

    try {
      expect(stubFetch).not.toHaveBeenCalled();
    } catch (err) {
      dumpOpsFetchSnapshot("no-raw-fetch-regression", { download, decrypt, decode });
      throw err;
    }
  });

  it("rejects with DECRYPT_FAILED when decrypt throws", async () => {
    console.info("[library-ops-fetch-integration:decrypt-throws] decrypt fn throws — expect DECRYPT_FAILED rejection");
    const ops = [makeEntry()];
    const download = vi.fn(async () => new Uint8Array([0]));
    const decrypt = vi.fn(async () => {
      throw new Error("boom");
    });
    const decode = vi.fn(() => "");

    try {
      await expect(
        fetchOpPayloads(ops, { download, decrypt, decode })
      ).rejects.toThrow("DECRYPT_FAILED");
    } catch (err) {
      const actual = await fetchOpPayloads(ops, { download, decrypt, decode }).catch((e) => e);
      console.error(`=== [library-ops-fetch-integration:decrypt-throws-wrong-error] ===`);
      console.error(`actual rejection: ${actual instanceof Error ? actual.message : String(actual)}`);
      dumpOpsFetchSnapshot("decrypt-throws-wrong-error", { download, decrypt, decode });
      throw err;
    }
  });

  it("emits library.ops.parse.failed when an entry fails", async () => {
    console.info("[library-ops-fetch-integration:parse-failed-event] download fn throws — expect library.ops.parse.failed event");
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const ops = [makeEntry({ opId: "bad", version: 7 })];
    const download = vi.fn(async () => {
      throw new Error("net-down");
    });
    const decrypt = vi.fn();
    const decode = vi.fn();
    const log = vi.fn((event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    });

    await expect(
      fetchOpPayloads(ops, { download, decrypt, decode, log })
    ).rejects.toThrow();
    console.info(`[library-ops-fetch-integration:parse-failed-event] captured ${events.length} events: ${JSON.stringify(events.map((e) => e.event))}`);

    try {
      expect(
        events.some(
          (event) =>
            event.event === "library.ops.parse.failed" &&
            event.data.id === "bad" &&
            event.data.version === 7
        )
      ).toBe(true);
    } catch (err) {
      dumpOpsFetchSnapshot("parse-failed-event-missing", { download, decrypt, decode, events });
      throw err;
    }
  });

  it("prefers inline payloadCiphertext over a tunnel download when present", async () => {
    /**
     * @bugfix Mobile shows "Offline" with TUNNEL_DOWNLOAD_ERROR_download_source_missing
     *   when the storage gateway can't find an op blob in its storage. The API now inlines
     *   the postgres-stored ciphertext into /library/db/ops responses; this test
     *   asserts the helper consumes that inline copy without ever calling the
     *   download fn, which keeps sync alive across gateway storage drift.
     * @regression-proof If the inline path is removed, `download` will be invoked,
     *   failing the toHaveBeenCalledTimes(0) assertion below.
     */
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    // "AQID" base64 = bytes [1, 2, 3]
    const ops = [makeEntry({ opId: "with-inline", payloadCiphertext: "AQID" })];
    const download = vi.fn(async () => new Uint8Array([0xff]));
    const decrypt = vi.fn(async (bytes: Uint8Array) => bytes);
    const decode = vi.fn(() => okOp);
    const log = vi.fn((event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    });

    console.info("[library-ops-fetch-integration:inline-preferred] fetching op with inline payloadCiphertext — download must NOT be called");
    const result = await fetchOpPayloads(ops, { download, decrypt, decode, log });
    console.info(`[library-ops-fetch-integration:inline-preferred] result.length=${result.length} download.calls=${download.mock.calls.length} decrypt.calls=${decrypt.mock.calls.length}`);

    try {
      expect(result).toHaveLength(1);
      expect(download).toHaveBeenCalledTimes(0);
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(decrypt.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
      expect(events.some((e) => e.event === "library.ops.item" && e.data.source === "inline")).toBe(true);
    } catch (err) {
      dumpOpsFetchSnapshot("inline-preferred-mismatch", { download, decrypt, decode, events, result });
      throw err;
    }
  });

  it("falls back to tunnel download when inline payloadCiphertext is absent", async () => {
    console.info("[library-ops-fetch-integration:tunnel-fallback] fetching op without inline ciphertext — download must be called");
    const ops = [makeEntry({ opId: "no-inline" })];
    const download = vi.fn(async () => new Uint8Array([0xaa]));
    const decrypt = vi.fn(async (bytes: Uint8Array) => bytes);
    const decode = vi.fn(() => okOp);

    await fetchOpPayloads(ops, { download, decrypt, decode });
    console.info(`[library-ops-fetch-integration:tunnel-fallback] download.calls=${download.mock.calls.length}`);

    try {
      expect(download).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpOpsFetchSnapshot("tunnel-fallback-mismatch", { download, decrypt, decode });
      throw err;
    }
  });

  it("respects concurrency batch size and preserves version order", async () => {
    console.info("[library-ops-fetch-integration:batch-order] fetching 5 ops with batchSize=2 — expecting input-order calls");
    const calls: string[] = [];
    const ops = [
      makeEntry({ opId: "v1", version: 1, objectKey: "k/1" }),
      makeEntry({ opId: "v2", version: 2, objectKey: "k/2" }),
      makeEntry({ opId: "v3", version: 3, objectKey: "k/3" }),
      makeEntry({ opId: "v4", version: 4, objectKey: "k/4" }),
      makeEntry({ opId: "v5", version: 5, objectKey: "k/5" }),
    ];
    const download = vi.fn(async (key: string) => {
      calls.push(key);
      return new Uint8Array([0]);
    });
    const decrypt = vi.fn(async (b: Uint8Array) => b);
    const decode = vi.fn((_: Uint8Array) =>
      JSON.stringify({ type: "noop", id: calls[calls.length - 1] })
    );

    const result = await fetchOpPayloads(ops, { download, decrypt, decode }, 2);
    console.info(`[library-ops-fetch-integration:batch-order] result.length=${result.length} call-order=${JSON.stringify(calls)}`);

    try {
      expect(result).toHaveLength(5);
      // Calls happen in the input order even when batched
      expect(calls).toEqual(["k/1", "k/2", "k/3", "k/4", "k/5"]);
    } catch (err) {
      dumpOpsFetchSnapshot("batch-order-mismatch", { download, decrypt, decode, downloaded: calls, result });
      throw err;
    }
  });
});
