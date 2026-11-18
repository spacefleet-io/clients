import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FFMPEG_COMPONENTS, MOBILE_FEATURES } from "../src/features";
import { MEDIA_TEST_SET, MEDIA_TEST_SET_UNCOVERED, coveredComponents } from "../src/mediaTestSet";
import { writeSyntheticPgs } from "../src/syntheticMedia";

const LOG = "[media-deps:media-test-set]";
const dir = mkdtempSync(join(tmpdir(), "sf-media-test-set-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("media format test set", () => {
  /** @req REL-DEPS-11 the test set exercises every demuxer and decoder the mobile libmpv keeps. */
  it("covers every demuxer and decoder of the mobile build, or names why not", () => {
    const covered = coveredComponents();
    const kept = (["demuxer", "decoder"] as const).flatMap((kind) => MOBILE_FEATURES.ffmpegComponents[kind].map((name) => `${kind}:${name}`));
    const missing = kept.filter((key) => !covered.has(key) && !(key in MEDIA_TEST_SET_UNCOVERED));
    const stale = Object.keys(MEDIA_TEST_SET_UNCOVERED).filter((key) => !kept.includes(key) || covered.has(key));
    const foreign = [...covered].filter((key) => !kept.includes(key));
    console.info(`${LOG} fixtures=${MEDIA_TEST_SET.length} kept=${kept.length} covered=${covered.size} uncovered=${Object.keys(MEDIA_TEST_SET_UNCOVERED).length}`);
    if (missing.length || stale.length || foreign.length) {
      console.error(`${LOG} missing=${JSON.stringify(missing)} stale=${JSON.stringify(stale)} foreign=${JSON.stringify(foreign)}`);
    }
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(foreign).toEqual([]);
  });

  /**
   * @bugfix @regression-proof @req REL-DEPS-11 lavf's mpegps demuxer identifies the video PES of a .mpg/.vob by
   * probing it with the raw `mpegvideo` demuxer (demux.c `fmt_id_type`). Without it the OnePlus 6 saw no video track
   * and a phantom mp3 track in both files, so both libmpv builds must keep it and the PS fixtures must exercise it.
   */
  it("keeps the mpegvideo demuxer that mpegps probes .mpg/.vob video with", () => {
    const ps = MEDIA_TEST_SET.filter((f) => f.covers.demuxer?.includes("mpegps"));
    console.info(`${LOG} mpegps fixtures=${JSON.stringify(ps.map((f) => [f.id, f.covers.demuxer]))}`);
    expect(ps.map((f) => f.id)).toEqual(["mpg-mpeg1video-mp2", "vob-mpeg2video-ac3"]);
    for (const fixture of ps) expect(fixture.covers.demuxer, fixture.id).toContain("mpegvideo");
    expect(FFMPEG_COMPONENTS.demuxer).toContain("mpegvideo");
    expect(MOBILE_FEATURES.ffmpegComponents.demuxer).toContain("mpegvideo");
  });

  it("has unique fixture ids", () => {
    const ids = MEDIA_TEST_SET.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins every downloaded sample by sha256", () => {
    const fetches = MEDIA_TEST_SET.flatMap((f) => f.build.flatMap((step) => ("fetch" in step ? [step.fetch] : [])));
    console.info(`${LOG} fetches=${JSON.stringify(fetches.map((f) => f.url))}`);
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) expect(fetch.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every text subtitle a cue text and no bitmap subtitle one", () => {
    for (const fixture of MEDIA_TEST_SET) {
      const sub = fixture.expect.subtitle;
      if (sub) expect(Boolean(sub.text), fixture.id).toBe(!sub.bitmap);
    }
  });
});

describe("synthetic PGS", () => {
  it("writes a display set at the cue start and a clearing set at its end", () => {
    const path = join(dir, "box.sup");
    writeSyntheticPgs(path, { width: 640, height: 360, cues: [{ startS: 0.5, endS: 2.5, x: 120, y: 260, w: 400, h: 60 }] });
    const bytes = readFileSync(path);
    const segments: { ptsS: number; type: number; size: number }[] = [];
    for (let at = 0; at < bytes.length; ) {
      expect(bytes.toString("ascii", at, at + 2)).toBe("PG");
      const size = bytes.readUInt16BE(at + 11);
      segments.push({ ptsS: bytes.readUInt32BE(at + 2) / 90_000, type: bytes[at + 10]!, size });
      at += 13 + size;
    }
    console.info(`${LOG} pgs segments=${JSON.stringify(segments)}`);
    expect(segments.map((s) => [s.ptsS, s.type])).toEqual([
      [0.5, 0x16], [0.5, 0x17], [0.5, 0x14], [0.5, 0x15], [0.5, 0x80],
      [2.5, 0x16], [2.5, 0x17], [2.5, 0x80],
    ]);
    // PCS: video size, then one composition object at the cue position.
    const pcs = bytes.subarray(13, 13 + segments[0]!.size);
    expect([pcs.readUInt16BE(0), pcs.readUInt16BE(2)]).toEqual([640, 360]);
    expect(pcs[10]).toBe(1);
    expect([pcs.readUInt16BE(15), pcs.readUInt16BE(17)]).toEqual([120, 260]);
  });
});
