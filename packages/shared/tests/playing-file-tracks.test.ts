/**
 * @test-id SHARED-PLAYING-FILE-TRACKS-001
 * @level unit
 * @why PLAY-SUBGET-24 (Chris 2026-11-18, Black Hawk Down on the phone): the subtitle picker lists every subtitle the
 *   title already has. A subtitle file the user added beside a film (sidecar `.srt`, stored with
 *   `fileId: "external-subtitle:<candidate>"`) never equals the playing file's id, so the phone, cast, downloads, web
 *   player and Jellyfin scoping dropped it: the film looked subtitle-less and the picker went straight to the search.
 */
import { describe, expect, it } from "vitest";
import { isSidecarSubtitleFileId, sidecarSubtitleFileId, trackBelongsToPlayingFile } from "../src/libraryTypes";

const track = (fileId: string | null, episodeId: string | null) => ({ fileId, episodeId });

describe("the tracks of the playing file", () => {
  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] */
  it("keeps a film's sidecar subtitle, stored under its own external-subtitle id", () => {
    const sidecar = track(sidecarSubtitleFileId("cand-1"), null);
    console.info("[PLAY-SUBGET-24] sidecar", JSON.stringify(sidecar));
    expect(isSidecarSubtitleFileId(sidecar.fileId)).toBe(true);
    expect(trackBelongsToPlayingFile(sidecar, "file-1", null)).toBe(true);
  });

  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] */
  it("keeps the file's own tracks and unscoped ones, drops another version's", () => {
    expect(trackBelongsToPlayingFile(track("file-1", null), "file-1", null)).toBe(true);
    expect(trackBelongsToPlayingFile(track(null, null), "file-1", null)).toBe(true);
    expect(trackBelongsToPlayingFile(track("file-2", null), "file-1", null)).toBe(false);
    expect(isSidecarSubtitleFileId("file-2")).toBe(false);
    expect(isSidecarSubtitleFileId(null)).toBe(false);
  });

  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] */
  it("scopes an episode's tracks, sidecars included, by the episode", () => {
    expect(trackBelongsToPlayingFile(track(sidecarSubtitleFileId("c"), "ep-1"), "file-1", "ep-1")).toBe(true);
    expect(trackBelongsToPlayingFile(track(sidecarSubtitleFileId("c"), "ep-2"), "file-1", "ep-1")).toBe(false);
  });
});
