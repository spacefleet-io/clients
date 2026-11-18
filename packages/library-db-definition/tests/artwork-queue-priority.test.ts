/**
 * META-ART-01: a title the user just matched, refreshed or opened starts its copy at once, even while the paced
 * migration of the library runs: the pause between background titles is cut short, and a background title in
 * progress yields after the pictures it is fetching and resumes after the user's title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyMediaArtwork,
  createArtworkCopyQueue,
  type ArtworkCopy,
  type ArtworkCopyStore,
  type ArtworkSlot,
} from "../src/artworkCopy";

const log = (phase: string, data?: unknown) =>
  console.info(`[artwork-queue-priority] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

/** An in-memory library: each title holds `count` stills still stored as provider paths. */
const memoryStore = (titles: Record<string, number>): ArtworkCopyStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  for (const [mediaId, count] of Object.entries(titles)) {
    for (let index = 1; index <= count; index += 1) values.set(`${mediaId}-e${index}`, `/${mediaId}-e${index}.jpg`);
  }
  return {
    values,
    listArtworkToCopy: (mediaId) =>
      [...values]
        .filter(([id, value]) => id.startsWith(`${mediaId}-`) && value.startsWith("/"))
        .map(([id, path]): ArtworkSlot => ({ target: "episodeStill", id, path })),
    applyArtworkCopies: (_mediaId, copies: ArtworkCopy[]) => {
      let applied = 0;
      for (const copy of copies) {
        if (values.get(copy.id) !== copy.path) continue;
        values.set(copy.id, copy.value ?? "");
        applied += 1;
      }
      return { applied, skipped: copies.length - applied };
    },
  };
};

describe("foreground copies go first (META-ART-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("@req META-ART-01[badger-desktop] a title the user opens during the background pause starts at once", async () => {
    const started: { mediaId: string; at: number }[] = [];
    const queue = createArtworkCopyQueue({
      run: async (mediaId) => {
        started.push({ mediaId, at: Date.now() });
      },
      pauseMs: 2_000,
    });
    queue.schedule("bg1", { background: true });
    queue.schedule("bg2", { background: true });
    await vi.advanceTimersByTimeAsync(0);
    log("phase: bg1 done, pause running", started);
    await vi.advanceTimersByTimeAsync(300);
    queue.schedule("opened");
    await vi.advanceTimersByTimeAsync(0);
    log("phase: user opened a title 300 ms into the pause", started);
    expect(started.map((entry) => entry.mediaId)).toEqual(["bg1", "opened"]);
    expect(started[1]!.at, "the user's title does not wait out the 2 s pause").toBe(300);
    await vi.advanceTimersByTimeAsync(2_000);
    await queue.idle();
    log("phase: done", started);
    expect(started.map((entry) => entry.mediaId)).toEqual(["bg1", "opened", "bg2"]);
    expect(started[2]!.at, "the migration keeps its pace after the user's title").toBe(2_300);
  });

  it("@req META-ART-01[badger-desktop] a background title in progress yields between pictures and resumes after the user's title", async () => {
    const store = memoryStore({ bg: 6, opened: 2 });
    const fetched: string[] = [];
    const finishers: (() => void)[] = [];
    const upload = (_kind: string, path: string) =>
      new Promise<{ status: "ok"; key: string }>((resolve) => {
        fetched.push(path);
        finishers.push(() => resolve({ status: "ok", key: `asset:image/jpeg::assets${path}.txt` }));
      });
    const finishNext = async () => {
      finishers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    };
    const results: { mediaId: string; yielded: boolean; copied: number }[] = [];
    const queue = createArtworkCopyQueue({
      run: async (mediaId, control) => {
        const result = await copyMediaArtwork({ store, mediaId, upload, concurrency: 1, shouldYield: control.shouldYield });
        results.push({ mediaId, yielded: result.yielded, copied: result.copied });
        return result;
      },
      pauseMs: 2_000,
    });
    queue.schedule("bg", { background: true });
    await vi.advanceTimersByTimeAsync(0);
    await finishNext();
    log("phase: bg copying its second picture", { fetched });
    expect(fetched).toEqual(["/bg-e1.jpg", "/bg-e2.jpg"]);
    queue.schedule("opened");
    await finishNext();
    log("phase: bg's picture in flight finished, the user's title runs", { fetched, results });
    expect(fetched.slice(2), "the user's title starts right after bg's current picture").toEqual(["/opened-e1.jpg"]);
    await finishNext();
    await finishNext();
    log("phase: user's title done, bg is queued again first of its lane", { fetched, results });
    expect(results).toEqual([
      { mediaId: "bg", yielded: true, copied: 2 },
      { mediaId: "opened", yielded: false, copied: 2 },
    ]);
    while (finishers.length > 0 || fetched.length < 8) {
      await vi.advanceTimersByTimeAsync(500);
      await finishNext();
    }
    await queue.idle();
    log("phase: done", { fetched, results });
    expect(fetched, "no picture is fetched twice").toEqual([
      "/bg-e1.jpg",
      "/bg-e2.jpg",
      "/opened-e1.jpg",
      "/opened-e2.jpg",
      "/bg-e3.jpg",
      "/bg-e4.jpg",
      "/bg-e5.jpg",
      "/bg-e6.jpg",
    ]);
    expect(results.at(-1)).toEqual({ mediaId: "bg", yielded: false, copied: 4 });
    expect([...store.values.values()].every((value) => value.startsWith("asset:"))).toBe(true);
  });
});
