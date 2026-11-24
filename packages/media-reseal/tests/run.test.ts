import { randomBytes } from "node:crypto";
import type { MediaResealCopies, MediaResealProgress } from "@space/shared/api";
import { decryptMediaObject, encryptMediaObject } from "@space/media-crypto";
import { describe, expect, it } from "vitest";
import { collectResealCopies, RESEAL_PAGE_MAX, runMediaReseal, type ResealIo, type ResealRunProgress, type ResealUpload } from "../src/run";
import { importResealKey } from "../src/sealing";

const P = "0f0e0d0c-0b0a-4908-8706-050403020100";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Stored = { key: string; bytes: Uint8Array; objectNamespace: string | null; contentType: string | null };

/** A run the way the API keeps it: pending = no copy and no kept mark, paged by key with `pageSize`. */
const fakeServer = (objects: Stored[], pageSize: number) => {
  const copies = new Map<string, { newKey: string; bytes: Uint8Array; upload: ResealUpload }>();
  const kept = new Set<string>();
  const taken = new Set<string>();
  const sorted = [...objects].sort((a, b) => (a.key < b.key ? -1 : 1));
  const done = (key: string) => copies.has(key) || kept.has(key);
  const calls = { pending: [] as Array<string | null>, markKept: [] as string[][] };
  const io: ResealIo = {
    pending: async (after, limit) => {
      calls.pending.push(after);
      expect(limit).toBeLessThanOrEqual(RESEAL_PAGE_MAX);
      const waiting = sorted.filter((o) => !done(o.key) && (after === null || o.key > after));
      const page = waiting.slice(0, Math.min(limit, pageSize));
      const pendingBytes = sorted.filter((o) => !done(o.key)).reduce((sum, o) => sum + o.bytes.byteLength, 0);
      const progress: MediaResealProgress = {
        run: { id: "run-1", status: "open", createdAt: "2026-11-23T00:00:00.000Z", switchedAt: null, abandonedAt: null },
        uploadsInFlight: 0,
        switchNowAt: null,
        totalFiles: sorted.length,
        totalBytes: sorted.reduce((sum, o) => sum + o.bytes.byteLength, 0),
        doneFiles: sorted.filter((o) => done(o.key)).length,
        doneBytes: 0,
        keptFiles: kept.size,
        pendingFiles: sorted.length - sorted.filter((o) => done(o.key)).length,
        pendingBytes,
        pending: page.map((o) => ({
          key: o.key,
          sizeBytes: o.bytes.byteLength,
          role: null,
          objectNamespace: o.objectNamespace,
          contentType: o.contentType,
          app: "badger",
        })),
        nextAfter: waiting.length > page.length ? page[page.length - 1]!.key : null,
      };
      return progress;
    },
    download: async (key) => {
      const found = sorted.find((o) => o.key === key);
      if (!found) throw new Error(`not found: ${key}`);
      return found.bytes;
    },
    upload: async (copyKey, sealed, upload) => {
      if (taken.has(copyKey)) throw Object.assign(new Error("409"), { code: "reseal_target_taken" });
      expect(sealed.byteLength).toBe(sorted.find((o) => o.key === upload.of)!.bytes.byteLength);
      copies.set(upload.of, { newKey: copyKey, bytes: sealed, upload });
    },
    markKept: async (keys) => {
      calls.markKept.push(keys);
      expect(keys.length).toBeLessThanOrEqual(RESEAL_PAGE_MAX);
      for (const key of keys) kept.add(key);
    },
    copies: async (after, limit) => {
      const rows = sorted
        .filter((o) => done(o.key) && (after === null || o.key > after))
        .map((o) => ({ oldKey: o.key, newKey: copies.get(o.key)?.newKey ?? null, sizeBytes: o.bytes.byteLength, kept: kept.has(o.key) }));
      const page = rows.slice(0, Math.min(limit, pageSize));
      const result: MediaResealCopies = { copies: page, nextAfter: rows.length > page.length ? page[page.length - 1]!.oldKey : null };
      return result;
    },
  };
  return { io, copies, kept, taken, calls };
};

const setup = async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const keys = { from: await importResealKey(new Uint8Array(oldKey)), to: await importResealKey(new Uint8Array(newKey)) };
  const sealed = (n: number) => encryptMediaObject(new TextEncoder().encode(`piece ${n}`), oldKey, n);
  return { oldKey, newKey, keys, sealed };
};

describe("runMediaReseal (STOR-RESEAL-01/02/03/05, ACCT-KEYCHG-09)", () => {
  it("copies every readable object next to its old one, marks the rest kept, and counts download plus upload", async () => {
    const { newKey, keys, sealed } = await setup();
    const objects: Stored[] = [
      { key: `media/${P}/${uuid(1)}`, bytes: sealed(1), objectNamespace: "media", contentType: "video/mp4" },
      { key: `media/${P}/${uuid(2)}`, bytes: randomBytes(64), objectNamespace: "media", contentType: null },
      { key: `assets/cover-3`, bytes: sealed(3), objectNamespace: null, contentType: "image/jpeg" },
      { key: `media/${P}/${uuid(4)}`, bytes: sealed(4), objectNamespace: "media", contentType: null },
      { key: `media/${P}/${uuid(5)}`, bytes: sealed(5), objectNamespace: "media", contentType: null },
    ];
    const server = fakeServer(objects, 2);
    const seen: ResealRunProgress[] = [];
    let n = 100;

    const result = await runMediaReseal(server.io, keys, { onProgress: (p) => seen.push(p), uuid: () => uuid((n += 1)) });

    expect(result).toEqual({ copied: 4, kept: 1, stopped: false });
    expect(server.kept).toEqual(new Set([`media/${P}/${uuid(2)}`]));
    // Paged by key: each next page starts after the last key of the previous one.
    expect(server.calls.pending.length).toBe(3);
    const cover = server.copies.get("assets/cover-3")!;
    expect(cover.newKey).toMatch(/^assets\/00000000-0000-4000-8000-0000000001\d\d$/);
    expect(cover.upload).toEqual({ of: "assets/cover-3", objectNamespace: null, contentType: "image/jpeg", placementId: null });
    const first = server.copies.get(`media/${P}/${uuid(1)}`)!;
    expect(first.newKey.startsWith(`media/${P}/`)).toBe(true);
    expect(first.upload).toEqual({ of: `media/${P}/${uuid(1)}`, objectNamespace: "media", contentType: "video/mp4", placementId: P });
    expect(new TextDecoder().decode(decryptMediaObject(first.bytes, newKey.toString("base64")))).toBe("piece 1");

    const total = objects.reduce((sum, o) => sum + o.bytes.byteLength, 0);
    const last = seen[seen.length - 1]!;
    expect(seen[0]).toEqual({ totalFiles: 5, doneFiles: 0, keptFiles: 0, transferBytes: 2 * total, transferredBytes: 0 });
    expect(last).toEqual({ totalFiles: 5, doneFiles: 5, keptFiles: 1, transferBytes: 2 * total, transferredBytes: 2 * total });
    // The download counts before the upload starts (key order: the cover is first).
    expect(seen[1]!.transferredBytes).toBe(objects[2]!.bytes.byteLength);
  });

  it("resumes from what the server still lists, and the collector maps old keys to copies without the kept ones", async () => {
    const { keys, sealed } = await setup();
    const objects: Stored[] = [1, 2, 3].map((i) => ({ key: `media/${P}/${uuid(i)}`, bytes: sealed(i), objectNamespace: "media", contentType: null }));
    objects.push({ key: `media/${P}/${uuid(9)}`, bytes: randomBytes(40), objectNamespace: "media", contentType: null });
    const server = fakeServer(objects, 500);
    const stop = new AbortController();
    let uploads = 0;
    const upload = server.io.upload;
    server.io.upload = async (...args) => {
      await upload(...args);
      uploads += 1;
      if (uploads === 1) stop.abort();
    };

    expect(await runMediaReseal(server.io, keys, { signal: stop.signal })).toEqual({ copied: 1, kept: 0, stopped: true });
    const again = await runMediaReseal(server.io, keys);
    expect(again).toEqual({ copied: 2, kept: 1, stopped: false });

    const map = await collectResealCopies(server.io);
    expect([...map.keys()].sort()).toEqual([1, 2, 3].map((i) => `media/${P}/${uuid(i)}`));
    for (const [oldKey, newKey] of map) expect(newKey).toBe(server.copies.get(oldKey)!.newKey);
  });

  it("draws a new copy name once when the first is taken, and stops on any other upload error", async () => {
    const { keys, sealed } = await setup();
    const server = fakeServer([{ key: `media/${P}/${uuid(1)}`, bytes: sealed(1), objectNamespace: "media", contentType: null }], 500);
    server.taken.add(`media/${P}/${uuid(500)}`);
    const names = [uuid(500), uuid(501)];
    expect(await runMediaReseal(server.io, keys, { uuid: () => names.shift()! })).toEqual({ copied: 1, kept: 0, stopped: false });
    expect(server.copies.get(`media/${P}/${uuid(1)}`)!.newKey).toBe(`media/${P}/${uuid(501)}`);

    const failing = fakeServer([{ key: `media/${P}/${uuid(2)}`, bytes: sealed(2), objectNamespace: "media", contentType: null }], 500);
    failing.io.upload = async () => {
      throw new Error("tunnel closed");
    };
    await expect(runMediaReseal(failing.io, keys)).rejects.toThrow("tunnel closed");
  });

  it("marks unreadable objects kept in batches of at most 500", async () => {
    const { keys } = await setup();
    const objects: Stored[] = Array.from({ length: 1203 }, (_, i) => ({
      key: `media/${P}/${uuid(i)}`,
      bytes: randomBytes(32),
      objectNamespace: "media",
      contentType: null,
    }));
    const server = fakeServer(objects, 500);
    expect(await runMediaReseal(server.io, keys)).toEqual({ copied: 0, kept: 1203, stopped: false });
    expect(server.calls.markKept.map((batch) => batch.length)).toEqual([500, 500, 203]);
  });

  it("counts a kept file only once the server lists it, and marks it before the next copy (ACCT-KEYCHG-07)", async () => {
    const { keys, sealed } = await setup();
    const objects: Stored[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      key: `media/${P}/${uuid(n)}`,
      bytes: n % 3 === 2 ? randomBytes(64) : sealed(n),
      objectNamespace: "media",
      contentType: null,
    }));
    const server = fakeServer(objects, 500);
    const upload = server.io.upload;
    const keptAtUpload: number[] = [];
    server.io.upload = async (copyKey, bytes, copy) => {
      keptAtUpload.push(server.kept.size);
      await upload(copyKey, bytes, copy);
    };
    const shown: number[] = [];

    await runMediaReseal(server.io, keys, {
      onProgress: (p) => {
        // "See the N files" lists what the server holds: the count shown never runs ahead of it.
        expect(p.keptFiles).toBeLessThanOrEqual(server.kept.size);
        shown.push(p.keptFiles);
      },
    });

    // uuid(2) is marked before uuid(3) is uploaded, uuid(5) before uuid(6).
    expect(keptAtUpload).toEqual([0, 1, 1, 2]);
    expect(server.calls.markKept).toEqual([[`media/${P}/${uuid(2)}`], [`media/${P}/${uuid(5)}`]]);
    expect(shown.at(-1)).toBe(2);
  });
});
