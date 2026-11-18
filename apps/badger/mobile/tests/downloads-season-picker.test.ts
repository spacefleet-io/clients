import { describe, expect, it } from "vitest";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { downloadedSeasonNumbers, seasonPickerChanges, seasonPickerRows } from "../src/lib/downloads/seasonPicker";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";

const NET = { networkAllowed: true, wifiOnly: false };

const item = (id: string, status: DownloadItem["status"]): DownloadItem => ({
  id,
  mediaId: "m",
  title: "T",
  subtitle: null,
  kind: "episode",
  seasonNumber: 1,
  episodeNumber: 1,
  quality: "1080p",
  formatId: "f",
  codec: "h264",
  status,
  errorCode: null,
  errorMessage: null,
  estimatedBytes: 1000,
  totalObjects: 10,
  doneBytes: status === "completed" ? 1000 : 0,
  doneObjects: status === "completed" ? 10 : 0,
  storedBytes: 0,
  createdAt: 0,
  completedAt: 0,
});

const file = (season: number, episode: number) => ({
  id: `s${season}e${episode}`,
  filename: `s${season}e${episode}`,
  season,
  episode,
  desiredFormats: [],
});

// S0 specials (1 ep), S1 (2 eps), S2 (2 eps), S3 (2 eps), plus a stray movie-like file.
const details = {
  files: [file(2, 1), file(0, 1), file(1, 1), file(1, 2), file(2, 2), file(3, 1), file(3, 2), { id: "x", filename: "x", season: null, episode: null, desiredFormats: [] }],
} as unknown as Pick<MediaDetails, "files">;

const byId = (items: DownloadItem[]) => new Map(items.map((i) => [i.id, i]));

describe("show download season picker", () => {
  // S1 fully saved, S2 one of two episodes saved (per-episode choice), S3 fully queued.
  const items = byId([item("s1e1", "completed"), item("s1e2", "completed"), item("s2e1", "completed"), item("s3e1", "queued"), item("s3e2", "downloading")]);
  const rows = seasonPickerRows(details, items, NET);

  it("lists every season with files, specials last, and ticks only seasons wholly offline or on their way", () => {
    expect(rows.map((r) => [r.seasonNumber, r.initiallyChecked])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [0, false],
    ]);
  });

  it("confirming without touching anything changes nothing (partial seasons are not widened)", () => {
    const untouched = new Set(rows.filter((r) => r.initiallyChecked).map((r) => r.seasonNumber));
    expect(seasonPickerChanges(rows, untouched, items)).toEqual({ add: [], removeIds: [] });
  });

  it("ticking downloads the season, unticking removes only that season's downloads", () => {
    expect(seasonPickerChanges(rows, new Set([2, 3, 0]), items)).toEqual({ add: [2, 0], removeIds: ["s1e1", "s1e2"] });
    // Unticking a season still downloading cancels its queue.
    expect(seasonPickerChanges(rows, new Set([1]), items)).toEqual({ add: [], removeIds: ["s3e1", "s3e2"] });
  });

  it("stamps only seasons whose every episode is saved", () => {
    expect([...downloadedSeasonNumbers(rows)]).toEqual([1]);
  });
});
