/**
 * @test-id MOBILE-PLAYBACK-FILE-CHAPTERS-001
 * @level unit
 *
 * PLAY-CHAP-01: the player shows the chapters of the file being played, also when the copy played (an offline
 * download of a lower quality) has no chapter rows of its own.
 */
import { describe, expect, it, vi } from "vitest";

// offlinePlayback reads the native download queue; only its pure format filter is exercised here.
vi.mock("@space/mobile-media-proxy/downloads", () => ({ nativeGetState: async () => ({ items: [] }) }));

import { filterToDownloadedFormat } from "../src/lib/downloads/offlinePlayback";
import { chaptersForFile } from "../src/lib/playback/fileChapters";

const format = (id: string) => ({ id, fileId: "file-1" });
const chapter = (id: string, formatId: string, startSeconds: number) => ({ id, formatId, title: id, startSeconds });

// The runtime writes chapter rows only for the source job's format (1080p); the 480p copy has none.
const fileFormats = [format("fmt-1080"), format("fmt-480")];
const chapters = [chapter("c2", "fmt-1080", 600), chapter("c1", "fmt-1080", 0), chapter("c3", "fmt-1080", 1200)];

describe("chapters of the file being played", () => {
  // @req PLAY-CHAP-01[badger-mobile]
  it("a downloaded lower-quality copy without chapter rows still shows the file's chapters, in order", () => {
    const played = filterToDownloadedFormat(fileFormats, { formatId: "fmt-480" });
    console.log("played formats", played.map((f) => f.id), "rows", chapters.map((c) => `${c.formatId}:${c.id}`));
    const shown = chaptersForFile(chapters, played, fileFormats);
    expect(shown.map((c) => c.id), JSON.stringify({ played, shown })).toEqual(["c1", "c2", "c3"]);
  });

  // @req PLAY-CHAP-01[badger-mobile,badger-tv]
  it("the played format's own rows win, and the same timeline stored under two formats is not listed twice", () => {
    const both = [...chapters, chapter("d1", "fmt-480", 0), chapter("d2", "fmt-480", 650)];
    const shown = chaptersForFile(both, fileFormats, fileFormats);
    console.log("both formats have rows", shown.map((c) => c.id));
    expect(shown.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    const lower = chaptersForFile(both, [format("fmt-480")], fileFormats);
    expect(lower.map((c) => c.id), "the played copy's own rows are preferred").toEqual(["d1", "d2"]);
  });

  // @req PLAY-CHAP-01[badger-mobile,badger-tv]
  it("a file with no chapter rows in any format has no chapters, and another file's chapters never leak in", () => {
    const other = [chapter("x1", "fmt-other", 0)];
    expect(chaptersForFile(other, fileFormats, fileFormats)).toEqual([]);
    expect(chaptersForFile([], fileFormats, fileFormats)).toEqual([]);
  });
});
