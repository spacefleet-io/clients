/**
 * @req PLAY-SKIP-09
 *
 * The show page's times panel (Chris 2026-11-23/24, chat, skip UX, via Main): the bar shows the part of the episode
 * where the intro or the credits sit, the handles never cross and stay on it, and the pictures come from the
 * episode's stored seek-bar previews.
 */
import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaSkipMarker } from "@space/shared/libraryTypes";
import {
  episodeDurationSeconds,
  episodePreviewSheets,
  formatSkipClock,
  initialSkipHandles,
  moveSkipHandle,
  skipHandlesSavable,
  skipPanelPicture,
  skipPanelRange,
} from "../src/renderer/src/lib/skipTimesPanel";

const marker = (type: "intro" | "credits", startSeconds: number, endSeconds: number): MediaSkipMarker => ({
  id: `m-${type}`,
  mediaId: "pr",
  episodeId: "e2",
  type,
  startSeconds,
  endSeconds,
  source: "detected",
  confidence: null,
  createdAt: "",
  updatedAt: "",
});

const previews = {
  version: 1 as const,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 300,
  sheets: [
    { objectKey: "sheet-0", sizeBytes: 1, firstPicture: 0, pictureCount: 100 },
    { objectKey: "sheet-1", sizeBytes: 1, firstPicture: 100, pictureCount: 100 },
    { objectKey: "sheet-2", sizeBytes: 1, firstPicture: 200, pictureCount: 100 },
  ],
};

const media = {
  id: "pr",
  episodes: [
    { id: "e2", seasonNumber: 2, episodeNumber: 2 },
    { id: "e3", seasonNumber: 2, episodeNumber: 3 },
  ],
  files: [
    { id: "f2", season: 2, episode: 2 },
    { id: "f3", season: 2, episode: 3 },
  ],
  formats: [
    { fileId: "f2", isSource: true, durationSeconds: 1290, previewSheets: previews },
    { fileId: "f2", isSource: false, durationSeconds: 1291.5, previewSheets: null },
    { fileId: "f3", isSource: true, durationSeconds: null, previewSheets: null },
  ],
} as unknown as MediaDetails;

describe("skip times panel (PLAY-SKIP-09)", () => {
  it("@req PLAY-SKIP-09 shows the intro in the first quarter (10 min at most) and the credits in the last 10 min", () => {
    expect(skipPanelRange("intro", 1290)).toEqual({ from: 0, to: 322.5 });
    expect(skipPanelRange("intro", 3600)).toEqual({ from: 0, to: 600 });
    expect(skipPanelRange("credits", 1290)).toEqual({ from: 690, to: 1290 });
    expect(skipPanelRange("credits", 300)).toEqual({ from: 0, to: 300 });
  });

  it("@req PLAY-SKIP-09 starts the handles on the episode's times, else at the start (intro) or 5 min before the end (credits)", () => {
    expect(initialSkipHandles("intro", marker("intro", 70, 90), 1290)).toEqual({ startSeconds: 70, endSeconds: 90 });
    expect(initialSkipHandles("intro", null, 1290)).toEqual({ startSeconds: 0, endSeconds: 0 });
    expect(initialSkipHandles("credits", marker("credits", 1276, 1290), 1290)).toEqual({ startSeconds: 1276, endSeconds: 1290 });
    expect(initialSkipHandles("credits", null, 1290)).toEqual({ startSeconds: 990, endSeconds: 1290 });
    // A time off the bar is brought onto it.
    expect(initialSkipHandles("intro", marker("intro", 10, 900), 1290)).toEqual({ startSeconds: 10, endSeconds: 322.5 });
  });

  it("@req PLAY-SKIP-09 keeps the handles on the bar and never lets them cross; the credits run to the end", () => {
    const intro = { startSeconds: 70, endSeconds: 90 };
    expect(moveSkipHandle("intro", intro, "start", 120, 1290)).toEqual({ startSeconds: 90, endSeconds: 90 });
    expect(moveSkipHandle("intro", intro, "start", -5, 1290)).toEqual({ startSeconds: 0, endSeconds: 90 });
    expect(moveSkipHandle("intro", intro, "end", 40, 1290)).toEqual({ startSeconds: 70, endSeconds: 70 });
    expect(moveSkipHandle("intro", intro, "end", 9999, 1290)).toEqual({ startSeconds: 70, endSeconds: 322.5 });
    expect(moveSkipHandle("credits", { startSeconds: 1000, endSeconds: 1290 }, "start", 500, 1290)).toEqual({ startSeconds: 690, endSeconds: 1290 });
  });

  it("@req PLAY-SKIP-09 saves only something to skip, inside the episode", () => {
    expect(skipHandlesSavable({ startSeconds: 70, endSeconds: 90 }, 1290)).toBe(true);
    expect(skipHandlesSavable({ startSeconds: 0, endSeconds: 0 }, 1290)).toBe(false);
    expect(skipHandlesSavable({ startSeconds: 1200, endSeconds: 1300 }, 1290)).toBe(false);
  });

  it("@req PLAY-SKIP-09 reads the length from the episode's longest format and the pictures from its source's previews", () => {
    expect(episodeDurationSeconds(media, "e2")).toBe(1291.5);
    expect(episodeDurationSeconds(media, "e3")).toBeNull();
    expect(episodePreviewSheets(media, "e2")).toBe(previews);
    expect(episodePreviewSheets(media, "e3")).toBeNull();
    // 1:44 is picture 20: row 2, column 0 of the first sheet.
    expect(skipPanelPicture(previews, 104)).toEqual({ objectKey: "sheet-0", x: 0, y: 180, width: 160, height: 90 });
    expect(skipPanelPicture(previews, 600)).toMatchObject({ objectKey: "sheet-1" });
    expect(skipPanelPicture(null, 104)).toBeNull();
  });

  it("@req PLAY-SKIP-09 writes times as a clock", () => {
    expect(formatSkipClock(104.9)).toBe("1:44");
    expect(formatSkipClock(0)).toBe("0:00");
    expect(formatSkipClock(3723)).toBe("1:02:03");
  });
});
