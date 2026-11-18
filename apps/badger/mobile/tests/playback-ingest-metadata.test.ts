import { describe, expect, it } from "vitest";
import { buildIngestMetadata } from "../src/lib/playback/ingestMetadata";

const baseInput = {
  formats: [],
  audioTracks: [],
  chapters: [],
  durationSeconds: 100,
};

const sub = (over: Partial<{ id: string; format: string | null; objectKey: string | null }>) => ({
  id: "s1",
  language: "fr",
  label: "French",
  isDefault: false,
  format: "vtt" as string | null,
  objectKey: "subs-fr/fre.vtt" as string | null,
  ...over,
});

describe("buildIngestMetadata subtitle formats", () => {
  it("keeps pgs as pgs and plain text formats as vtt", () => {
    const out = buildIngestMetadata({
      ...baseInput,
      subtitleTracks: [sub({ id: "a", format: "pgs", objectKey: "subs-fr-pgs/fre.sup" }), sub({ id: "b", format: "srt" })],
    });
    console.info("[ingest-metadata] formats", out.subtitleTracks.map((t) => `${t.id}:${t.format}`));
    expect(out.subtitleTracks.map((t) => t.format)).toEqual(["pgs", "vtt"]);
  });

  // @bugfix @regression-proof vobsub-mapped-to-vtt
  // Ingest stores VobSub (dvd_subtitle / dvb_subtitle) as a matroska file. PlayerScreen used to
  // tag everything that was not "pgs" as "vtt", which libavformat then demuxed as text -> no
  // subtitles ever rendered, and PlaybackBridge.parseSession would have rejected a real "vobsub".
  // @req PLAY-TRACK-05
  it("@bugfix @regression-proof maps matroska-stored VobSub to the vobsub format", () => {
    const out = buildIngestMetadata({
      ...baseInput,
      subtitleTracks: [
        sub({ id: "m1", format: "matroska", objectKey: "subs-fr-vobsub/fre.mkv" }),
        sub({ id: "m2", format: "mkv", objectKey: "subs-en-vobsub/eng.mkv" }),
        sub({ id: "m3", format: "dvd_subtitle", objectKey: "subs-de/ger.bin" }),
        sub({ id: "m4", format: "vobsub", objectKey: "subs-es/spa.sub" }),
        sub({ id: "m5", format: null, objectKey: "subs-it/ita.mkv" }),
      ],
    });
    console.info("[ingest-metadata] vobsub formats", out.subtitleTracks.map((t) => `${t.id}:${t.format}`));
    expect(out.subtitleTracks.map((t) => t.format)).toEqual(["vobsub", "vobsub", "vobsub", "vobsub", "vobsub"]);
  });

  it("drops subtitle rows without an object key", () => {
    const out = buildIngestMetadata({ ...baseInput, subtitleTracks: [sub({ objectKey: null })] });
    expect(out.subtitleTracks).toHaveLength(0);
  });
});

describe("buildIngestMetadata OCR twins", () => {
  const twin = (id: string, pictureId: string | null, objectKey: string | null) => ({
    ...sub({ id, format: "srt", objectKey }),
    source: "ocr",
    derivedFromSubtitleId: pictureId,
  });

  // @req PLAY-TRACK-05
  it("never lists a twin and attaches it to its picture track", () => {
    console.info("[ingest-metadata] phase: build with a PGS + VobSub picture track, their twins and a text track");
    const out = buildIngestMetadata({
      ...baseInput,
      subtitleTracks: [
        { ...sub({ id: "pgs", format: "pgs", objectKey: "subs-fr-pgs/fre.sup" }), source: "ingest", derivedFromSubtitleId: null },
        twin("pgs-ocr", "pgs", "subs-fr-pgs/fre.ocr.srt"),
        sub({ id: "vob", format: "mkv", objectKey: "subs-en-vobsub/eng.mkv" }),
        twin("vob-ocr", "vob", "subs-en-vobsub/eng.ocr.srt"),
        sub({ id: "text", format: "srt", objectKey: "subs-de/ger.srt" }),
      ],
    });
    console.info("[ingest-metadata] twins", JSON.stringify(out.subtitleTracks));
    expect(out.subtitleTracks.map((t) => t.id)).toEqual(["pgs", "vob", "text"]);
    expect(out.subtitleTracks[0].ocrTwin).toEqual({ id: "pgs-ocr", url: "subs-fr-pgs/fre.ocr.srt" });
    expect(out.subtitleTracks[1].ocrTwin).toEqual({ id: "vob-ocr", url: "subs-en-vobsub/eng.ocr.srt" });
    expect(out.subtitleTracks[2].ocrTwin).toBeUndefined();
    // The picture rows keep their own object and format: the menu and the remembered choice stay the picture's.
    expect(out.subtitleTracks.map((t) => `${t.format}:${t.url}`)).toEqual([
      "pgs:subs-fr-pgs/fre.sup",
      "vobsub:subs-en-vobsub/eng.mkv",
      "vtt:subs-de/ger.srt",
    ]);
  });

  // @req PLAY-TRACK-05
  it("hides an unlinked or object-less twin without attaching it", () => {
    const out = buildIngestMetadata({
      ...baseInput,
      subtitleTracks: [
        sub({ id: "pgs", format: "pgs", objectKey: "subs-fr-pgs/fre.sup" }),
        twin("orphan-ocr", null, "subs-fr-pgs/orphan.srt"),
        twin("pending-ocr", "pgs", null),
      ],
    });
    console.info("[ingest-metadata] unlinked twins", JSON.stringify(out.subtitleTracks));
    expect(out.subtitleTracks.map((t) => t.id)).toEqual(["pgs"]);
    expect(out.subtitleTracks[0].ocrTwin).toBeUndefined();
  });
});
