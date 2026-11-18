import { describe, expect, it } from "vitest";
import { completedMediaIds, filterDownloadedMedia } from "../src/lib/downloads/decisions";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";

const item = (over: Partial<DownloadItem> & { id: string; mediaId: string }): DownloadItem => ({
  title: "T",
  subtitle: null,
  kind: "episode",
  seasonNumber: 1,
  episodeNumber: 1,
  quality: "1080p",
  formatId: "f",
  codec: "h264",
  status: "completed",
  errorCode: null,
  errorMessage: null,
  estimatedBytes: 1000,
  totalObjects: 10,
  doneBytes: 1000,
  doneObjects: 10,
  storedBytes: 1000,
  createdAt: 0,
  completedAt: 1,
  ...over,
});

describe("Library 'downloaded only' filter @bugfix @regression-proof", () => {
  it("keeps only titles with at least one COMPLETED download (real downloads, not hasFiles / offlineState)", () => {
    const media = [{ id: "got" }, { id: "lotr" }, { id: "other" }];
    const ids = completedMediaIds(
      [
        item({ id: "f1", mediaId: "got" }),
        item({ id: "f2", mediaId: "lotr", status: "downloading", doneBytes: 10 }),
        item({ id: "f3", mediaId: "other", status: "failed", errorCode: "network" }),
      ],
      null,
    );
    const out = filterDownloadedMedia(media, ids);
    console.info("[downloads-library-filter] kept", out.map((m) => m.id));
    expect(out.map((m) => m.id)).toEqual(["got"]);
  });

  it("returns the previous Set instance when progress pushes do not change which titles are downloaded", () => {
    const first = completedMediaIds([item({ id: "f1", mediaId: "got" }), item({ id: "f2", mediaId: "lotr", status: "downloading" })], null);
    const second = completedMediaIds(
      [item({ id: "f1", mediaId: "got" }), item({ id: "f2", mediaId: "lotr", status: "downloading", doneBytes: 500 })],
      first,
    );
    expect(second).toBe(first);
    const third = completedMediaIds([item({ id: "f1", mediaId: "got" }), item({ id: "f2", mediaId: "lotr" })], second);
    expect(third).not.toBe(second);
    expect([...third].sort()).toEqual(["got", "lotr"]);
  });

  it("is empty with no downloads", () => {
    expect(filterDownloadedMedia([{ id: "a" }], completedMediaIds([], null))).toEqual([]);
  });
});
