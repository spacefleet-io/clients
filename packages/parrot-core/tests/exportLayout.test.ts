/**
 * @test-id PARROT-CORE-EXPORT-LAYOUT-001
 * @level unit
 * @why "Download everything" saves each song as `Artist/Album/01 Title.ext` (OFFL-FILE-02, Chris
 *   2026-11-21). A wrong pad, a folder per track artist, a name Windows refuses, or two songs whose names differ only in
 *   letter case landing on one file (overwrite on Windows/macOS) would lose or scatter the user's music.
 * @covers packages/parrot-core/src/exportLayout.ts
 * @req OFFL-FILE-02[parrot]
 */
import { describe, expect, it } from "bun:test";
import { parrotExportNameKey, parrotExportPath, PARROT_EXPORT_UNKNOWN_ALBUM, PARROT_EXPORT_UNKNOWN_ARTIST } from "../src/exportLayout";

const log = (message: string, detail?: unknown) => console.log(`[PARROT-CORE-EXPORT-LAYOUT-001] ${message}`, detail === undefined ? "" : JSON.stringify(detail));

const base = { artist: "Nina Simone", albumArtist: "Nina Simone", album: "Pastel Blues", title: "Sinnerman", trackNumber: 9, discNumber: 1, discCount: 1, albumTrackCount: 9, ext: "flac" };

describe("parrotExportPath", () => {
  it("lays out Artist/Album/NN Title.ext with a two-digit number", () => {
    const out = parrotExportPath(base);
    log("simple", out);
    expect(out).toEqual({ folders: ["Nina Simone", "Pastel Blues"], file: "09 Sinnerman.flac" });
  });

  it("pads to three digits when the album has 100 songs or more", () => {
    const out = parrotExportPath({ ...base, trackNumber: 7, albumTrackCount: 120 });
    log("120-track album", out);
    expect(out.file).toBe("007 Sinnerman.flac");
    expect(parrotExportPath({ ...base, trackNumber: 104, albumTrackCount: 120 }).file).toBe("104 Sinnerman.flac");
    // A number above the count still pads to its own width.
    expect(parrotExportPath({ ...base, trackNumber: 100, albumTrackCount: 12 }).file).toBe("100 Sinnerman.flac");
  });

  it("leaves the number out when the song has none", () => {
    const out = parrotExportPath({ ...base, trackNumber: null });
    log("no number", out);
    expect(out.file).toBe("Sinnerman.flac");
  });

  it("prefixes the disc on an album with several discs", () => {
    const out = parrotExportPath({ ...base, trackNumber: 3, discNumber: 2, discCount: 2 });
    log("disc 2 of 2", out);
    expect(out).toEqual({ folders: ["Nina Simone", "Pastel Blues"], file: "2-03 Sinnerman.flac" });
    // A single-disc album never shows a disc, whatever its disc number says.
    expect(parrotExportPath({ ...base, trackNumber: 3, discNumber: 1, discCount: 1 }).file).toBe("03 Sinnerman.flac");
  });

  it("files a song under its album artist, a compilation under Various Artists", () => {
    const out = parrotExportPath({ ...base, artist: "Guest Singer", albumArtist: "Various Artists", album: "Jazz Hits" });
    log("compilation", out);
    expect(out.folders).toEqual(["Various Artists", "Jazz Hits"]);
    expect(parrotExportPath({ ...base, artist: "Track Artist", albumArtist: null }).folders[0]).toBe("Track Artist");
  });

  it("uses English placeholders for a missing artist, album or title", () => {
    const out = parrotExportPath({ ...base, artist: null, albumArtist: "  ", album: "", title: null, trackNumber: 1 });
    log("missing", out);
    expect(out).toEqual({ folders: [PARROT_EXPORT_UNKNOWN_ARTIST, PARROT_EXPORT_UNKNOWN_ALBUM], file: "01 Unknown Title.flac" });
    expect(PARROT_EXPORT_UNKNOWN_ARTIST).toBe("Unknown Artist");
    expect(PARROT_EXPORT_UNKNOWN_ALBUM).toBe("Unknown Album");
  });

  it("removes characters no file system takes, and never makes a hidden or Windows-reserved name", () => {
    const out = parrotExportPath({ ...base, albumArtist: 'AC/DC: "Live"?', album: ".Hidden...", title: "Who* <Are> You|\u0007 ", trackNumber: 2 });
    log("unsafe", out);
    expect(out.folders[0]).toBe("ACDC Live");
    expect(out.folders[1]).toBe("Hidden");
    expect(out.file).toBe("02 Who Are You.flac");
    const reserved = parrotExportPath({ ...base, albumArtist: "CON", album: "aux", title: "nul", trackNumber: null });
    log("reserved", reserved);
    expect(reserved).toEqual({ folders: ["CON_", "aux_"], file: "nul_.flac" });
  });

  it("keeps dots inside names and the case of what follows them", () => {
    const out = parrotExportPath({ ...base, albumArtist: "St. Vincent", album: "Vol.II", title: "Mr. Blue Sky", trackNumber: 1, ext: "M4A" });
    log("dots", out);
    expect(out).toEqual({ folders: ["St. Vincent", "Vol.II"], file: "01 Mr. Blue Sky.m4a" });
  });

  it("caps long names so the whole path fits Windows", () => {
    const long = "x".repeat(400);
    const out = parrotExportPath({ ...base, albumArtist: long, album: long, title: long });
    log("lengths", { artist: out.folders[0]!.length, album: out.folders[1]!.length, file: out.file.length });
    expect(out.folders[0]!.length).toBeLessThanOrEqual(80);
    expect(out.folders[1]!.length).toBeLessThanOrEqual(80);
    expect(out.file.length).toBeLessThanOrEqual(80 + ".flac".length);
    expect(out.file.endsWith(".flac")).toBe(true);
  });
});

describe("parrotExportNameKey (folders of one artist merge)", () => {
  it("compares without letter case, and composed and decomposed accents as one (macOS)", () => {
    const decomposed = "Beyonce\u0301";
    const composed = "BEYONC\u00c9";
    log("keys", { decomposed: parrotExportNameKey(decomposed), composed: parrotExportNameKey(composed) });
    expect(parrotExportNameKey(decomposed)).toBe(parrotExportNameKey(composed));
  });
});
