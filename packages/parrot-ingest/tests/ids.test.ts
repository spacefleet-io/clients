/**
 * @test-id PARROT-INGEST-IDS-001
 * @level unit
 * @why Importing the same file again, on any device, must land on the same library rows (INGS-RESUME-01): the ids
 *      are pure functions of names and content, case-insensitive for names, and distinct where the song differs.
 * @covers packages/parrot-ingest/src/ids.ts
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { parrotShortId } from "@space/parrot-core";
import { parrotChunkKey, parrotPlacementId, parrotTrackIds, sha256Hex } from "../src/ids";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-IDS-001");

const nook = {
  artist: "Linnet Park",
  albumArtist: "Linnet Park",
  album: "Meltway",
  disc: 1,
  number: 13,
  title: "Nook",
  fileHash: sha256Hex("nook bytes"),
};

describe("parrot ids", () => {
  it("hashes strings and bytes with SHA-256 hex", () => {
    const expected = createHash("sha256").update("abc").digest("hex");
    log("sha256Hex(abc)", sha256Hex("abc"));
    expect(sha256Hex("abc")).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
  });

  it("builds short ids as prefix + 24 hex digits over NUL-joined parts", () => {
    const id = parrotShortId("ar", "linnet park");
    log("short id", id);
    expect(id).toMatch(/^ar-[0-9a-f]{24}$/);
    expect(id).toBe(`ar-${sha256Hex("linnet park").slice(0, 24)}`);
    expect(parrotShortId("tr", "a", 1, "b")).toBe(`tr-${sha256Hex("a\u00001\u0000b").slice(0, 24)}`);
    // The NUL separator keeps part boundaries: ("ab","c") and ("a","bc") differ.
    expect(parrotShortId("x", "ab", "c")).not.toBe(parrotShortId("x", "a", "bc"));
  });

  it("derives stable, case-insensitive track ids", () => {
    const ids = parrotTrackIds(nook);
    log("ids for Nook", ids);
    expect(ids.artistId).toMatch(/^ar-[0-9a-f]{24}$/);
    expect(ids.albumId).toMatch(/^al-[0-9a-f]{24}$/);
    expect(ids.trackId).toMatch(/^tr-[0-9a-f]{24}$/);
    expect(ids.fileId).toBe(`tf-${sha256Hex(nook.fileHash).slice(0, 24)}`);
    expect(ids.albumArtistId).toBe(ids.artistId);
    expect(parrotTrackIds(nook)).toEqual(ids);
    const shouted = parrotTrackIds({ ...nook, artist: "LINNET PARK", albumArtist: "linnet park", album: "MELTWAY", title: "NOOK" });
    log("ids for shouted names", shouted);
    expect(shouted).toEqual(ids);
  });

  it("separates songs that differ in album, disc, number, title or content", () => {
    const base = parrotTrackIds(nook);
    const variants = {
      otherAlbum: parrotTrackIds({ ...nook, album: "Live in Tarvo" }),
      otherDisc: parrotTrackIds({ ...nook, disc: 2 }),
      otherNumber: parrotTrackIds({ ...nook, number: 12 }),
      otherTitle: parrotTrackIds({ ...nook, title: "Nook/Reprise" }),
      otherFile: parrotTrackIds({ ...nook, fileHash: sha256Hex("other bytes") }),
      otherAlbumArtist: parrotTrackIds({ ...nook, albumArtist: "Various Artists" }),
    };
    log("variants", variants);
    expect(variants.otherAlbum.albumId).not.toBe(base.albumId);
    expect(variants.otherAlbum.trackId).not.toBe(base.trackId);
    expect(variants.otherAlbum.artistId).toBe(base.artistId);
    expect(variants.otherDisc.trackId).not.toBe(base.trackId);
    expect(variants.otherDisc.albumId).toBe(base.albumId);
    expect(variants.otherNumber.trackId).not.toBe(base.trackId);
    expect(variants.otherTitle.trackId).not.toBe(base.trackId);
    expect(variants.otherFile.fileId).not.toBe(base.fileId);
    expect(variants.otherFile.trackId).toBe(base.trackId);
    expect(variants.otherAlbumArtist.albumArtistId).not.toBe(base.artistId);
    expect(variants.otherAlbumArtist.artistId).toBe(base.artistId);
    expect(variants.otherAlbumArtist.albumId).not.toBe(base.albumId);
  });

  it("derives placement ids per account and file, and zero-padded chunk keys", () => {
    const placement = parrotPlacementId("user-1", nook.fileHash);
    log("placement", placement);
    expect(placement).toMatch(/^parrot-[0-9a-f]{32}$/);
    expect(placement).toBe(parrotPlacementId("user-1", nook.fileHash));
    expect(parrotPlacementId("user-2", nook.fileHash)).not.toBe(placement);
    expect(parrotChunkKey("tf-abc", 0)).toBe("tf-abc/chunk-00000");
    expect(parrotChunkKey("tf-abc", 42)).toBe("tf-abc/chunk-00042");
    expect(parrotChunkKey("tf-abc", 123456)).toBe("tf-abc/chunk-123456");
  });
});
