/**
 * @req MPV-PREV-01[badger-desktop]
 *
 * Seek-bar preview pictures, main-process side (`src/main/mpvPreviewPictures.ts`): the OSC's hover request
 * (`sf-preview-hover <token> <seconds>`) is answered with the right picture cut from the right sheet
 * (`locatePreviewPicture`), each sheet is fetched at most once per playback and kept in memory, a request that is no
 * longer the latest is dropped, and a video without previews (null or malformed record) gets nothing at all.
 *
 * The decoded sheets are synthetic: every pixel of picture `i` holds `i` in its blue byte and the sheet index in its
 * green byte, so a cut picture shows exactly where it was cut from.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import type { PreviewPicturePayload, PreviewSheetsPayload } from "@space/mpv-protocol";
import {
  createMpvPreviewPictures,
  decodeSheetWithNativeImage,
  sweepStalePreviewDirs,
  type MpvPreviewPictures,
} from "../src/main/mpvPreviewPictures";

const TAG = "[mpv-preview-pictures]";
const W = 4;
const H = 2;
const COLUMNS = 10;

/** 150 pictures (12.5 min) in two sheets: 100 + 50. */
const record = (): MediaPreviewSheets => ({
  version: 1,
  intervalSeconds: 5,
  pictureWidth: W,
  pictureHeight: H,
  columns: COLUMNS,
  rows: 10,
  pictureCount: 150,
  sheets: [
    { objectKey: "media/m1/previews/sheet-000", sizeBytes: 1000, firstPicture: 0, pictureCount: 100 },
    { objectKey: "media/m1/previews/sheet-001", sizeBytes: 500, firstPicture: 100, pictureCount: 50 },
  ],
});

/** Raw BGRA of a sheet: picture `i` (within the sheet) filled with B = i, G = sheet index, R = 7, A = 255. */
const syntheticSheet = (sheetIndex: number, pictureCount: number): Buffer => {
  const rows = Math.ceil(pictureCount / COLUMNS);
  const width = COLUMNS * W;
  const buf = Buffer.alloc(width * rows * H * 4);
  for (let py = 0; py < rows * H; py++) {
    for (let px = 0; px < width; px++) {
      const picture = Math.floor(py / H) * COLUMNS + Math.floor(px / W);
      const o = (py * width + px) * 4;
      buf[o] = picture;
      buf[o + 1] = sheetIndex;
      buf[o + 2] = 7;
      buf[o + 3] = 255;
    }
  }
  return buf;
};

const sheetIndexOf = (jpeg: Buffer) => Number(jpeg.toString());

type Harness = {
  service: MpvPreviewPictures;
  fetchKeys: string[];
  decodes: number;
  sheets: PreviewSheetsPayload[];
  pictures: PreviewPicturePayload[];
  staleDrops: number;
  /** Resolves once `ready()` holds, re-checked after every fetch, picture and log line of the service. */
  until: (label: string, ready: () => boolean) => Promise<void>;
  root: string;
};

const live: Harness[] = [];

type StatusAnswer = { state: "pending" | "failed"; failures: number; maxAttempts: number } | null;

/** Lets every queued promise callback run (one macrotask turn, no wall-clock duration). */
const flush = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const makeHarness = (
  opts: {
    debounceMs?: number;
    fetchSheet?: (key: string) => Promise<Buffer>;
    previewStatus?: (formatId: string) => Promise<StatusAnswer>;
  } = {},
): Harness => {
  const root = mkdtempSync(join(tmpdir(), "sf-preview-test-"));
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const check of [...waiters]) check();
  };
  const until = (label: string, ready: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => {
      if (!ready()) return;
      waiters.delete(check);
      console.info(`${TAG} ${label}`);
      resolve();
    };
    waiters.add(check);
    check();
    return promise;
  };
  const fetchSheet = opts.fetchSheet ?? (async (key: string) => Buffer.from(String(record().sheets.findIndex((s) => s.objectKey === key))));
  const h: Harness = { service: null as unknown as MpvPreviewPictures, fetchKeys: [], decodes: 0, sheets: [], pictures: [], staleDrops: 0, until, root };
  h.service = createMpvPreviewPictures({
    fetchSheet: (key) => {
      h.fetchKeys.push(key);
      changed();
      return fetchSheet(key);
    },
    // The "JPEG" carries the sheet index; the fake decoder turns it into the synthetic pixels.
    decodeSheet: async (jpeg, width) => {
      expect(width).toBe(COLUMNS * W);
      h.decodes += 1;
      const index = sheetIndexOf(jpeg);
      return syntheticSheet(index, record().sheets[index]!.pictureCount);
    },
    sendSheets: (payload) => {
      h.sheets.push(payload);
      changed();
    },
    ...(opts.previewStatus ? { previewStatus: opts.previewStatus } : {}),
    sendPicture: (payload) => {
      h.pictures.push(payload);
      changed();
    },
    tempRoot: root,
    debounceMs: opts.debounceMs ?? 0,
    log: {
      info: () => {},
      warn: () => {},
      debug: (_obj, msg) => {
        if (msg === "preview picture dropped (stale)") h.staleDrops += 1;
        changed();
      },
    },
  });
  live.push(h);
  return h;
};

afterEach(() => {
  vi.useRealTimers();
  for (const h of live.splice(0)) {
    h.service.disposeSync();
    rmSync(h.root, { recursive: true, force: true });
  }
});

/** Every pixel of the picture file: [B, G, R, A] must be identical; returns it. */
const uniformPixel = (path: string | null): number[] => {
  expect(path).not.toBeNull();
  const data = readFileSync(path!);
  expect(data.length).toBe(W * H * 4);
  const first = [data[0]!, data[1]!, data[2]!, data[3]!];
  for (let o = 0; o < data.length; o += 4) expect([data[o], data[o + 1], data[o + 2], data[o + 3]]).toEqual(first);
  return first;
};

/**
 * @req MPV-PREV-06[badger-desktop]
 * A video with no preview record yet: the seek bar says "Previews are being prepared" (the OSC draws the `hint`)
 * while the catch-up pass still means to make them, and nothing at all once it gave up on the video.
 */
describe("seek-bar hint while previews are missing (MPV-PREV-06)", () => {
  const HINT = "Previews are being prepared";

  it("sends the hint for a video whose previews are still to come, and never fetches anything", async () => {
    const asked: string[] = [];
    const h = makeHarness({
      previewStatus: async (formatId) => {
        asked.push(formatId);
        return { state: "pending", failures: 1, maxAttempts: 3 };
      },
    });
    h.service.setPreviews(null, { formatId: "fmt-1", hint: HINT });
    await h.until("hint sent", () => h.sheets.length === 1);
    console.info(`${TAG} pending: sheets=${JSON.stringify(h.sheets)} asked=${JSON.stringify(asked)}`);
    expect(h.sheets).toEqual([{ hint: HINT }]);
    expect(asked).toEqual(["fmt-1"]);
    // Hovering asks nothing of storage: there is no picture to show.
    h.service.hover(1, 30);
    await flush();
    expect(h.fetchKeys).toEqual([]);
    expect(h.pictures).toEqual([]);
    // A metadata re-send of the same missing record re-tells the OSC without asking the runtime again.
    h.service.setPreviews(null, { formatId: "fmt-1", hint: HINT });
    await h.until("hint re-sent", () => h.sheets.length === 2);
    expect(h.sheets[1]).toEqual({ hint: HINT });
    expect(asked).toEqual(["fmt-1"]);
  });

  it("shows the hint when the runtime cannot be asked (its pass is what makes them)", async () => {
    const h = makeHarness({ previewStatus: async () => null });
    h.service.setPreviews(null, { formatId: "fmt-1", hint: HINT });
    await h.until("hint sent (status unknown)", () => h.sheets.length === 1);
    expect(h.sheets).toEqual([{ hint: HINT }]);
  });

  it("no misleading hint once generation gave up on the video: the OSC gets null and draws nothing", async () => {
    const h = makeHarness({ previewStatus: async () => ({ state: "failed", failures: 3, maxAttempts: 3 }) });
    h.service.setPreviews(null, { formatId: "fmt-bad", hint: HINT });
    await h.until("null sent (failed)", () => h.sheets.length === 1);
    console.info(`${TAG} failed: sheets=${JSON.stringify(h.sheets)}`);
    expect(h.sheets).toEqual([null]);
  });

  it("a video with its record gets the thumbnails, without asking the runtime", async () => {
    const asked: string[] = [];
    const h = makeHarness({
      previewStatus: async (formatId) => {
        asked.push(formatId);
        return { state: "pending", failures: 0, maxAttempts: 3 };
      },
    });
    h.service.setPreviews(record(), { formatId: "fmt-1", hint: HINT });
    expect(h.sheets).toEqual([{ width: W, height: H, intervalSeconds: 5 }]);
    h.service.hover(1, 67);
    await h.until("picture after record", () => h.pictures.length === 1);
    expect(uniformPixel(h.pictures[0]!.path)).toEqual([13, 0, 7, 255]);
    expect(asked).toEqual([]);
  });

  it("the record arriving while the runtime is still answering wins: the late answer sends no hint", async () => {
    const answer = Promise.withResolvers<StatusAnswer>();
    const h = makeHarness({ previewStatus: () => answer.promise });
    h.service.setPreviews(null, { formatId: "fmt-1", hint: HINT });
    h.service.setPreviews(record(), { formatId: "fmt-1", hint: HINT });
    answer.resolve({ state: "pending", failures: 0, maxAttempts: 3 });
    await flush();
    console.info(`${TAG} race: sheets=${JSON.stringify(h.sheets)}`);
    expect(h.sheets).toEqual([{ width: W, height: H, intervalSeconds: 5 }]);
  });

  it("without a format to ask about (no source format), or without a hint text, nothing is drawn", () => {
    const h = makeHarness({ previewStatus: async () => ({ state: "pending", failures: 0, maxAttempts: 3 }) });
    h.service.setPreviews(null, { formatId: null, hint: HINT });
    h.service.setPreviews(null);
    expect(h.sheets).toEqual([null, null]);
  });
});

describe("seek-bar preview pictures in the main process (MPV-PREV-01)", () => {
  it("answers a hover with the picture locatePreviewPicture points at, in both sheets", async () => {
    const h = makeHarness();
    h.service.setPreviews(JSON.stringify(record()));
    expect(h.sheets).toEqual([{ width: W, height: H, intervalSeconds: 5 }]);

    // 67 s -> picture 13 of sheet 0 (column 3, row 1)
    h.service.hover(1, 67);
    await h.until("picture 13", () => h.pictures.length === 1);
    console.info(`${TAG} picture 1: ${JSON.stringify(h.pictures[0])}`);
    expect(h.pictures[0]).toMatchObject({ token: 1, width: W, height: H });
    expect(uniformPixel(h.pictures[0]!.path)).toEqual([13, 0, 7, 255]);

    // 523 s -> picture 104 = picture 4 of sheet 1
    h.service.hover(2, 523);
    await h.until("picture 104", () => h.pictures.length === 2);
    expect(uniformPixel(h.pictures[1]!.path)).toEqual([4, 1, 7, 255]);

    // past the end clamps to the last picture (149 = picture 49 of sheet 1)
    h.service.hover(3, 10_000);
    await h.until("last picture", () => h.pictures.length === 3);
    expect(uniformPixel(h.pictures[2]!.path)).toEqual([49, 1, 7, 255]);
  });

  it("fetches each sheet once per playback and keeps it in memory", async () => {
    const h = makeHarness();
    h.service.setPreviews(record());
    for (let token = 1; token <= 6; token++) {
      h.service.hover(token, token * 5 + 1);
      await h.until(`hover ${token}`, () => h.pictures.length === token);
    }
    console.info(`${TAG} cache: fetches=${JSON.stringify(h.fetchKeys)} decodes=${h.decodes}`);
    expect(h.fetchKeys).toEqual(["media/m1/previews/sheet-000"]);
    expect(h.decodes).toBe(1);

    // The renderer re-sends the same record (reload, marker change): the cache stays.
    h.service.setPreviews(JSON.stringify(record()));
    h.service.hover(7, 41);
    await h.until("hover after same record", () => h.pictures.length === 7);
    expect(h.fetchKeys).toHaveLength(1);

    // Only the newest picture stays on disk (the OSC confirmed none), in the private dir.
    const dir = h.service.getDir()!;
    expect(dir.startsWith(h.root)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);

    // A new playback starts clean: the sheet is fetched again; app exit removes the dir.
    h.service.reset();
    h.service.setPreviews(record());
    h.service.hover(8, 41);
    await h.until("hover after reset", () => h.pictures.length === 8);
    expect(h.fetchKeys).toHaveLength(2);
    h.service.disposeSync();
    expect(existsSync(dir)).toBe(false);
  });

  it("prefetches the neighbouring sheet when the pointer nears a sheet edge", async () => {
    const h = makeHarness();
    h.service.setPreviews(record());
    h.service.hover(1, 95 * 5);
    await h.until("picture 95", () => h.pictures.length === 1);
    await h.until("sheet 1 prefetched", () => h.fetchKeys.length === 2);
    expect(h.fetchKeys).toEqual(["media/m1/previews/sheet-000", "media/m1/previews/sheet-001"]);
  });

  it("answers path null when the sheet cannot be shown, so the OSC removes the previous picture", async () => {
    const h = makeHarness({
      fetchSheet: async (key) => {
        if (key.endsWith("sheet-001")) throw new Error("preview sheet HTTP 401");
        return Buffer.from("0");
      },
    });
    h.service.setPreviews(record());
    h.service.hover(1, 67);
    await h.until("sheet 0 picture", () => h.pictures.length === 1);
    expect(h.pictures[0]).toMatchObject({ token: 1, width: W, height: H });
    // 8:43 is on sheet 1, whose fetch fails: no picture for this moment, said explicitly.
    h.service.hover(2, 523);
    await h.until("no picture for sheet 1", () => h.pictures.length === 2);
    console.info(`${TAG} failed sheet answer: ${JSON.stringify(h.pictures[1])}`);
    expect(h.pictures[1]).toEqual({ token: 2, path: null });
    // The failure stays for this playback (no second fetch), and every hover on that sheet still says so.
    h.service.hover(3, 600);
    await h.until("still no picture for sheet 1", () => h.pictures.length === 3);
    expect(h.pictures[2]).toEqual({ token: 3, path: null });
    expect(h.fetchKeys.filter((key) => key.endsWith("sheet-001"))).toHaveLength(1);
  });

  it("keeps the picture file the OSC shows until it shows another one", async () => {
    const h = makeHarness();
    h.service.setPreviews(record());
    h.service.hover(1, 6);
    await h.until("picture 1", () => h.pictures.length === 1);
    const shownFile = h.pictures[0]!.path!;
    h.service.shown(1);
    // The pointer moves on twice before the OSC accepts another answer (it drops 2 as stale).
    h.service.hover(2, 11);
    await h.until("picture 2", () => h.pictures.length === 2);
    h.service.hover(3, 16);
    await h.until("picture 3", () => h.pictures.length === 3);
    const dir = h.service.getDir()!;
    console.info(`${TAG} files while 1 is shown: ${JSON.stringify(readdirSync(dir).sort())}`);
    // The OSC re-runs overlay-add from the shown file whenever the pointer moves: it must still exist.
    expect(existsSync(shownFile)).toBe(true);
    expect(existsSync(h.pictures[1]!.path!)).toBe(false);
    expect(readdirSync(dir)).toHaveLength(2);
    // Once the OSC shows picture 3, picture 1 goes.
    h.service.shown(3);
    await vi.waitFor(() => expect(existsSync(shownFile)).toBe(false));
    expect(readdirSync(dir)).toEqual([h.pictures[2]!.path!.split("/").at(-1)]);
  });

  it("sweeps preview dirs left by an app that is gone, never a running one's", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sf-preview-sweep-"));
    try {
      const dead = join(tmp, "sf-mpv-previews-999999999-abc123");
      const alive = join(tmp, `sf-mpv-previews-${process.pid}-def456`);
      const other = join(tmp, "sf-mpv-transient-1-2.log");
      for (const path of [dead, alive]) mkdirSync(path);
      writeFileSync(join(dead, "1.bgra"), "pixels");
      writeFileSync(other, "");
      const infos: unknown[] = [];
      await sweepStalePreviewDirs({
        tmp,
        isAlive: (pid) => pid === process.pid,
        log: { info: (obj) => infos.push(obj), warn: () => {} },
      });
      console.info(`${TAG} sweep left ${JSON.stringify(readdirSync(tmp).sort())}`);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(alive)).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect(infos).toEqual([{ removed: 1 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops a request that is no longer the latest", async () => {
    const slowFirst = Promise.withResolvers<void>();
    const h = makeHarness({
      fetchSheet: async (key) => {
        if (key.endsWith("000")) await slowFirst.promise;
        return Buffer.from(key.endsWith("000") ? "0" : "1");
      },
    });
    h.service.setPreviews(record());
    // Token 1 waits on the slow sheet 0; token 2 (sheet 1) lands first; token 1 must never be answered.
    h.service.hover(1, 10);
    await h.until("sheet 0 requested", () => h.fetchKeys.length >= 1);
    h.service.hover(2, 600);
    await h.until("token 2 answered", () => h.pictures.length === 1);
    slowFirst.resolve();
    await h.until("token 1 dropped as stale", () => h.staleDrops === 1);
    console.info(`${TAG} stale: pictures=${JSON.stringify(h.pictures.map((p) => p.token))}`);
    expect(h.pictures.map((p) => p.token)).toEqual([2]);
  });

  it("the pointer leaving the seekbar cancels the pending request", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = makeHarness({ debounceMs: 30 });
    h.service.setPreviews(record());
    h.service.hover(1, 20);
    expect(vi.getTimerCount()).toBe(1);
    h.service.hover(2, -1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(h.fetchKeys).toEqual([]);
    expect(h.pictures).toEqual([]);
  });

  it("debounces a fast scrub to its last position", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = makeHarness({ debounceMs: 25 });
    h.service.setPreviews(record());
    for (let token = 1; token <= 20; token++) {
      h.service.hover(token, token * 5);
      vi.advanceTimersByTime(10);
    }
    // Only the last hover is still scheduled, and nothing ran while the pointer kept moving.
    expect(vi.getTimerCount()).toBe(1);
    expect(h.fetchKeys).toEqual([]);
    vi.advanceTimersByTime(25);
    await h.until("last hover answered", () => h.pictures.length === 1);
    expect(h.pictures.map((p) => p.token)).toEqual([20]);
    expect(h.fetchKeys).toHaveLength(1);
    expect(uniformPixel(h.pictures[0]!.path)).toEqual([20, 0, 7, 255]);
  });

  it("a video without previews, or with a malformed record, gets no picture and no fetch", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const raw of [null, undefined, "", "{not json", { version: 1, sheets: [] }, { ...record(), pictureWidth: 4.5 }]) {
      const h = makeHarness();
      h.service.setPreviews(raw);
      h.service.hover(1, 30);
      // Nothing is even scheduled: the hover is ignored on the spot.
      expect(vi.getTimerCount()).toBe(0);
      console.info(`${TAG} no-previews raw=${JSON.stringify(raw)?.slice(0, 40)} sheets=${JSON.stringify(h.sheets)}`);
      expect(h.sheets).toEqual([null]);
      expect(h.fetchKeys).toEqual([]);
      expect(h.pictures).toEqual([]);
      expect(h.service.getDir()).toBeNull();
    }
  });

  it("decodes a sheet in process to BGRA rows of the sheet width, and refuses a sheet of another size", async () => {
    const image = (width: number, height: number, bytes = width * height * 4) => ({
      isEmpty: () => width === 0,
      getSize: () => ({ width, height }),
      toBitmap: () => Buffer.alloc(bytes, 7),
    });
    const jpeg = Buffer.from("jpeg");
    const seen: Buffer[] = [];
    const decode = decodeSheetWithNativeImage((bytes) => {
      seen.push(bytes);
      return image(COLUMNS * W, 3 * H);
    });
    const pixels = await decode(jpeg, COLUMNS * W);
    expect(seen).toEqual([jpeg]);
    expect(pixels.length).toBe(COLUMNS * W * 3 * H * 4);
    await expect(decodeSheetWithNativeImage(() => image(0, 0))(jpeg, COLUMNS * W)).rejects.toThrow(/not 40 px wide/);
    await expect(decodeSheetWithNativeImage(() => image(32, 2))(jpeg, COLUMNS * W)).rejects.toThrow(/not 40 px wide/);
    await expect(decodeSheetWithNativeImage(() => image(40, 2, 10))(jpeg, COLUMNS * W)).rejects.toThrow(/BGRA/);
  });
});
