/**
 * First-start transcode default (#25, Chris 2026-10-09): the per-computer
 * "fallback 360p copy" verdict and how it shapes the automatic ingest
 * ladder. Pure functions — no Electron, no ffmpeg.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_COPY_MIN_CORES, FALLBACK_COPY_MIN_RAM_GB, decideFallbackCopy, type TranscodeHardware } from "@space/shared/transcodeHardware";
import { applyFallbackCopyToFormats, applyFallbackCopyToOutputs, formatTranscodeDefaultLog } from "../src/shared/transcodeDefault";
import { DEFAULT_TRANSCODE_OUTPUTS } from "../src/shared/labQueueShared";
import { QUALITY_ORDER, defaultCodecForQuality } from "../src/shared/quality";

const P = "[transcode-default-rule]";

const dump = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== ${P}:${label} snapshot ===\n${JSON.stringify(ctx, null, 2)}\n=== end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("decideFallbackCopy", () => {
  console.info(`${P} thresholds cores>=${FALLBACK_COPY_MIN_CORES} ramGB>=${FALLBACK_COPY_MIN_RAM_GB}`);

  const table: Array<[string, TranscodeHardware, boolean]> = [
    // The reference box: 4-core i5, 8 GB, no GPU encoder.
    ["reference 4c/8GB no hw", { cores: 4, ramGB: 8, hwEncoder: "none" }, false],
    ["4c/16GB no hw", { cores: 4, ramGB: 16, hwEncoder: "none" }, false],
    ["4c/8GB vaapi", { cores: 4, ramGB: 8, hwEncoder: "vaapi" }, true],
    ["2c/4GB videotoolbox", { cores: 2, ramGB: 4, hwEncoder: "videotoolbox" }, true],
    ["4c/8GB nvenc", { cores: 4, ramGB: 8, hwEncoder: "nvenc" }, true],
    ["8c/12GB no hw (both floors exact)", { cores: 8, ramGB: 12, hwEncoder: "none" }, true],
    ["8c/16GB no hw", { cores: 8, ramGB: 16, hwEncoder: "none" }, true],
    ["16c/32GB no hw", { cores: 16, ramGB: 32, hwEncoder: "none" }, true],
    ["8c/11.9GB no hw (ram just under)", { cores: 8, ramGB: 11.9, hwEncoder: "none" }, false],
    ["7c/64GB no hw (cores just under)", { cores: 7, ramGB: 64, hwEncoder: "none" }, false],
    ["6c/12GB no hw", { cores: 6, ramGB: 12, hwEncoder: "none" }, false],
    ["12c/8GB no hw", { cores: 12, ramGB: 8, hwEncoder: "none" }, false],
  ];

  it.each(table)("%s", (label, hw, expected) => {
    const verdict = decideFallbackCopy(hw);
    console.info(`${P}:table ${label} ${JSON.stringify(hw)} -> fallbackCopy=${verdict ? "on" : "off"} (expected ${expected ? "on" : "off"})`);
    if (verdict !== expected) dump("table-mismatch", { label, hw, verdict, expected });
    expect(verdict).toBe(expected);
  });
});

describe("formatTranscodeDefaultLog", () => {
  it("logs inputs and verdict on one greppable line", () => {
    const line = formatTranscodeDefaultLog({ cores: 4, ramGB: 8, hwEncoder: "none" }, false, "first start");
    console.info(`${P}:log line=${line}`);
    expect(line).toBe("[transcode-default] cores=4 ramGB=8 hwEncoder=none -> fallbackCopy=off (first start)");
  });

  it("rounds RAM to one decimal", () => {
    const line = formatTranscodeDefaultLog({ cores: 8, ramGB: 15.5432, hwEncoder: "vaapi" }, true, "first start");
    console.info(`${P}:log-round line=${line}`);
    expect(line).toBe("[transcode-default] cores=8 ramGB=15.5 hwEncoder=vaapi -> fallbackCopy=on (first start)");
  });
});

describe("applyFallbackCopyToFormats (automatic ingest ladder)", () => {
  it("ON gives exactly one 360p copy when the account lists nothing", () => {
    const out = applyFallbackCopyToFormats([], true);
    console.info(`${P}:formats-on-empty out=${JSON.stringify(out)}`);
    expect(out).toEqual(["360p"]);
  });

  it("OFF gives no automatic copy at all", () => {
    const out = applyFallbackCopyToFormats([], false);
    console.info(`${P}:formats-off-empty out=${JSON.stringify(out)}`);
    expect(out).toEqual([]);
  });

  it("@req INGS-FALLBK-01 @req ACCT-SQUAD-03[badger-desktop] ON keeps the account's further qualities and adds 360p; OFF makes none of them", () => {
    const on = applyFallbackCopyToFormats(["720p"], true);
    const off = applyFallbackCopyToFormats(["720p"], false);
    console.info(`${P}:formats-extras on=${JSON.stringify(on)} off=${JSON.stringify(off)}`);
    expect(on).toEqual(["720p", "360p"]);
    expect(off).toEqual([]);
  });

  it("an account-level 360p never overrides the device value, and 360p appears once", () => {
    const off = applyFallbackCopyToFormats(["360p", "1080p"], false);
    const on = applyFallbackCopyToFormats(["360p", "1080p"], true);
    console.info(`${P}:formats-account-360 off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
    expect(off).toEqual([]);
    expect(on).toEqual(["1080p", "360p"]);
  });

  it("a stale account-level 480p is still ignored", () => {
    const on = applyFallbackCopyToFormats(["720p", "480p"], true);
    const off = applyFallbackCopyToFormats(["720p", "480p"], false);
    console.info(`${P}:formats-stale-480 on=${JSON.stringify(on)} off=${JSON.stringify(off)}`);
    expect(on).toEqual(["720p", "360p"]);
    expect(off).toEqual([]);
  });
});

describe("applyFallbackCopyToOutputs (Settings / ingest preview)", () => {
  it("@req INGS-FALLBK-01 @req ACCT-SQUAD-03[badger-desktop] OFF previews no automatic copy, ON drops 360p/480p entries and adds one H.264 360p", () => {
    const input = [
      { quality: "480p", codec: "hevc" },
      { quality: "360p", codec: "h264" },
      { quality: "720p", codec: "h264" },
    ] as const;
    const off = applyFallbackCopyToOutputs(input, false);
    const on = applyFallbackCopyToOutputs(input, true);
    console.info(`${P}:outputs off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
    expect(off).toEqual([]);
    expect(on).toEqual([
      { quality: "720p", codec: "h264" },
      { quality: "360p", codec: "h264" },
    ]);
  });

  it("with an empty account ladder, ON previews exactly one 360p copy and OFF none", () => {
    expect(applyFallbackCopyToOutputs([], true)).toEqual([{ quality: "360p", codec: "h264" }]);
    expect(applyFallbackCopyToOutputs([], false)).toEqual([]);
  });
});

describe("codec of extra qualities", () => {
  it("defaults to H.264 for every quality except 4K, which is HEVC @req INGS-QUAL-02", () => {
    const codecs = Object.fromEntries(QUALITY_ORDER.map((q) => [q, defaultCodecForQuality(q)]));
    console.info(`${P}:default-codecs ${JSON.stringify(codecs)}`);
    for (const q of QUALITY_ORDER) expect(codecs[q]).toBe(q === "2160p" ? "hevc" : "h264");
  });

  it("never adds an H.264 copy just because the source is HEVC @req INGS-QUAL-05", () => {
    // The automatic ladder is built from the requested qualities and the per-computer
    // fallback flag only: the source codec is not an input, so an HEVC upload gets
    // exactly the qualities an H.264 upload would get.
    console.info(
      `${P}:no-hevc-transcode defaults=${JSON.stringify(DEFAULT_TRANSCODE_OUTPUTS)} ladderArity=${applyFallbackCopyToFormats.length}`,
    );
    expect(DEFAULT_TRANSCODE_OUTPUTS).toEqual([]);
    expect(applyFallbackCopyToFormats.length).toBe(2);
    expect(applyFallbackCopyToFormats([], false)).toEqual([]);
    expect(applyFallbackCopyToFormats(["1080p"], true)).toEqual(["1080p", "360p"]);
  });
});
