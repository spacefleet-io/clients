/**
 * @test-id PARROT-CORE-CATALOG-001
 * @level unit
 * @why The album screen lists tracks in disc/number order, a track plays its original file stored whole (PAR-FMT-01),
 *   and the media proxy only serves a file whose chunks tile it exactly. A wrong order or file, or a gap in the
 *   chunks, shows up as the wrong song or a stall mid-song, so these rules are pinned here. The web player leaves out
 *   the files the browser cannot decode, so another stored copy plays (PLAT-WEB-08).
 * @covers packages/parrot-core/src/catalog.ts
 */
import { describe, expect, it } from "bun:test";
import { formatDuration, pickPlayableFile, sortTracks, toChunkedFile, type TrackFileRow } from "../src/catalog";

const file = (over: Partial<TrackFileRow>): TrackFileRow => ({
  id: "f",
  trackId: "t",
  mime: "audio/mpeg",
  lossless: false,
  bitrateKbps: 128,
  sizeBytes: 10,
  lightCopy: false,
  createdAt: 1,
  ...over,
});

describe("sortTracks", () => {
  it("orders by disc, then number, unnumbered last, then title", () => {
    const sorted = sortTracks([
      { id: "d2n1", disc: 2, number: 1, title: "a" },
      { id: "d1none", disc: 1, number: null, title: "a" },
      { id: "d1n13", disc: 1, number: 13, title: "Nook" },
      { id: "d1n2", disc: 1, number: 2, title: "z" },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["d1n2", "d1n13", "d1none", "d2n1"]);
  });
});

describe("pickPlayableFile", () => {
  it("prefers an original over a light copy, lossless over lossy, then the higher bitrate", () => {
    expect(
      pickPlayableFile([
        file({ id: "light", lightCopy: true, lossless: true }),
        file({ id: "mp3-128", bitrateKbps: 128 }),
        file({ id: "mp3-320", bitrateKbps: 320 }),
      ])?.id
    ).toBe("mp3-320");
    expect(pickPlayableFile([file({ id: "mp3-320", bitrateKbps: 320 }), file({ id: "flac", lossless: true, bitrateKbps: null })])?.id).toBe("flac");
  });

  it("falls back to a light copy when it is the only file, and null without files", () => {
    expect(pickPlayableFile([file({ id: "light", lightCopy: true })])?.id).toBe("light");
    expect(pickPlayableFile([])).toBeNull();
  });

  it("skips files the player cannot decode, falling back to a copy it can, else null", () => {
    const files = [
      file({ id: "alac", mime: "audio/mp4; codecs=alac", lossless: true, bitrateKbps: null }),
      file({ id: "light", mime: "audio/mp4; codecs=mp4a.40.2", lightCopy: true, bitrateKbps: 256 }),
    ];
    const noAlac = (mime: string) => !mime.includes("alac");
    expect(pickPlayableFile(files)?.id).toBe("alac");
    expect(pickPlayableFile(files, noAlac)?.id).toBe("light");
    expect(pickPlayableFile(files, () => false)).toBeNull();
  });
});

describe("toChunkedFile", () => {
  const nook = { id: "tf-1", mime: "audio/mpeg", sizeBytes: 2_961_371 };
  const MiB = 1024 * 1024;
  const chunks = [
    { idx: 2, objectKey: "c2", plainOffset: 2 * MiB, plainSize: 2_961_371 - 2 * MiB },
    { idx: 0, objectKey: "c0", plainOffset: 0, plainSize: MiB },
    { idx: 1, objectKey: "c1", plainOffset: MiB, plainSize: MiB },
  ];

  it("returns the chunks in byte order when they tile the file", () => {
    expect(toChunkedFile(nook, chunks)).toEqual({
      ...nook,
      chunks: [
        { objectKey: "c0", plainOffset: 0, plainSize: MiB },
        { objectKey: "c1", plainOffset: MiB, plainSize: MiB },
        { objectKey: "c2", plainOffset: 2 * MiB, plainSize: 2_961_371 - 2 * MiB },
      ],
    });
  });

  it("refuses a gap, an overlap or a short tail", () => {
    expect(() => toChunkedFile(nook, chunks.filter((c) => c.idx !== 1))).toThrow("FILE_CHUNKS_INCOMPLETE");
    expect(() => toChunkedFile(nook, [...chunks, { idx: 3, objectKey: "x", plainOffset: MiB, plainSize: 1 }])).toThrow(
      "FILE_CHUNKS_INCOMPLETE"
    );
    expect(() => toChunkedFile({ ...nook, sizeBytes: nook.sizeBytes + 1 }, chunks)).toThrow("FILE_CHUNKS_INCOMPLETE");
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours, and unknown durations", () => {
    expect(formatDuration(185_000)).toBe("3:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("--:--");
    expect(formatDuration(-1)).toBe("--:--");
  });
});
