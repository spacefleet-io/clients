/**
 * @test-id BADGER-DESKTOP-KEY-CHANGE-RESEAL-001
 * @level unit
 * @req ACCT-KEYCHG-06[badger-desktop]
 * @req ACCT-KEYCHG-07[badger-desktop]
 * @req ACCT-KEYCHG-09[badger-desktop]
 * @why Chris (2026-11-23, rotate drafts review, relayed by Main): the key change's estimate counts downloading every
 *   media file and uploading its copy; "Switch now" opens only once the server's 24-hour mark has passed; every file
 *   the old key could not open is listed, across pages, and nothing else. A refused switch's words live with the
 *   shared key change text (desktop-shell tests/key-change.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { MediaResealCopies } from "@space/shared/api";
import {
  ETA_WINDOW_MS,
  listUnreadableFiles,
  pushTransferSample,
  resealSecondsLeft,
  switchNowOpen,
  type ResealRunProgress,
} from "@space/media-reseal";

const SUITE = "[key-change-reseal]";

const MB = 1_000_000;
// 100 MB of media left: 100 MB to download and 100 MB to upload.
const progress = (transferredBytes: number): ResealRunProgress => ({
  totalFiles: 10,
  doneFiles: 0,
  keptFiles: 0,
  transferBytes: 200 * MB,
  transferredBytes,
});

describe(`${SUITE} estimate`, () => {
  it("counts the download and the upload of every file left", () => {
    // 1 MB/s measured over 10 s; 200 MB moved in all, 10 MB done: 190 s, not the 90 s an upload-only count gives.
    const samples = [
      { at: 0, bytes: 0 },
      { at: 10_000, bytes: 10 * MB },
    ];
    const seconds = resealSecondsLeft(samples, progress(10 * MB));
    console.log(`${SUITE} seconds=${seconds}`);
    expect(seconds).toBe(190);
  });

  it("has no estimate before five seconds of measured transfer", () => {
    expect(resealSecondsLeft([{ at: 0, bytes: 0 }, { at: 4_000, bytes: 4 * MB }], progress(4 * MB))).toBeNull();
    expect(resealSecondsLeft([{ at: 0, bytes: 0 }, { at: 6_000, bytes: 0 }], progress(0))).toBeNull();
  });

  it("measures the rate over the last two minutes only", () => {
    let samples = pushTransferSample([], { at: 0, bytes: 0 });
    samples = pushTransferSample(samples, { at: 60_000, bytes: MB });
    samples = pushTransferSample(samples, { at: ETA_WINDOW_MS + 60_000, bytes: 121 * MB });
    expect(samples.map((s) => s.at)).toEqual([60_000, ETA_WINDOW_MS + 60_000]);
  });
});

describe(`${SUITE} switch now`, () => {
  it("opens once the server's mark has passed, never without one", () => {
    const at = "2026-11-24T10:00:00.000Z";
    expect(switchNowOpen(null, Date.parse(at) + 1)).toBe(false);
    expect(switchNowOpen(at, Date.parse(at) - 1)).toBe(false);
    expect(switchNowOpen(at, Date.parse(at))).toBe(true);
  });
});

describe(`${SUITE} unreadable files`, () => {
  it("lists every kept file across pages, and no copied one", async () => {
    const copy = (n: number, kept: boolean) => ({ oldKey: `u/old-${n}`, newKey: kept ? null : `u/new-${n}`, sizeBytes: n, kept });
    const pages: Record<string, MediaResealCopies> = {
      first: { copies: [copy(1, true), copy(2, false)], nextAfter: "u/old-2" },
      "u/old-2": { copies: [copy(3, false), copy(4, true)], nextAfter: null },
    };
    const copies = vi.fn(async (after: string | null) => pages[after ?? "first"]!);
    const files = await listUnreadableFiles({ copies });
    console.log(`${SUITE} pages=${copies.mock.calls.length} files=${JSON.stringify(files)}`);
    expect(copies.mock.calls.map((c) => c[0])).toEqual([null, "u/old-2"]);
    expect(files).toEqual([
      { key: "u/old-1", sizeBytes: 1 },
      { key: "u/old-4", sizeBytes: 4 },
    ]);
  });
});
