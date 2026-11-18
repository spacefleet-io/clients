/**
 * @bugfix background-encode-starves-playback @regression-proof
 *
 * The DASH video encode argv must cap the decoder (before `-i`), the encoder
 * and the filter graph (after it) so a CPU retranscode leaves cores for
 * playback — while leaving the per-encoder recipe (`buildVideoEncoderArgs`,
 * which the encoder probe reuses verbatim) untouched.
 */

import { describe, expect, it } from "vitest";
import { buildDashVideoArgs, buildVideoEncoderArgs } from "../src/mediaProcessor";

const base = { inputPath: "/in/source.mkv", mpdPath: "/out/manifest.mpd", segmentSeconds: 4 };

describe("buildDashVideoArgs thread caps", () => {
  it("libx264 (cpu): -threads before -i, -threads + -filter_threads after the recipe", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "cpu", quality: "720p", threads: 2 });
    console.info("[dash-args-threads:x264]", args.join(" "));
    const inputIdx = args.indexOf("-i");
    expect(args.slice(inputIdx - 2, inputIdx)).toEqual(["-threads", "2"]);
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "720p");
    const recipeStart = args.indexOf("-c:v");
    expect(args.slice(recipeStart, recipeStart + encoderArgs.length)).toEqual(encoderArgs);
    const after = args.slice(recipeStart + encoderArgs.length);
    expect(after.slice(0, 4)).toEqual(["-threads", "2", "-filter_threads", "2"]);
    expect(args).not.toContain("-x265-params");
    expect(args.at(-1)).toBe("/out/manifest.mpd");
  });

  it("libx265 (cpu, 2160p): also caps the x265 pool", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "cpu", quality: "2160p", threads: 2 });
    console.info("[dash-args-threads:x265]", args.join(" "));
    expect(args).toContain("libx265");
    const i = args.indexOf("-x265-params");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("pools=2");
  });

  it("hardware encoder: no encoder -threads, but decode + filter threads are capped", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "vaapi", vaapiDevice: "/dev/dri/renderD128", quality: "720p", threads: 2 });
    const inputIdx = args.indexOf("-i");
    expect(args.slice(inputIdx - 2, inputIdx)).toEqual(["-threads", "2"]);
    expect(args.filter((a) => a === "-threads")).toHaveLength(1);
    expect(args).toContain("-filter_threads");
  });

  it("stream copy gets no thread flags", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "copy", threads: 2 });
    expect(args).not.toContain("-threads");
    expect(args).not.toContain("-filter_threads");
  });

  it("threads: 0 reproduces the uncapped argv", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "cpu", quality: "720p", threads: 0 });
    expect(args).not.toContain("-threads");
    expect(args).not.toContain("-filter_threads");
  });

  it("default threads come from the host policy and are never zero-by-accident", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "cpu", quality: "720p" });
    const n = Number(args[args.indexOf("-threads") + 1]);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("stdin input keeps pipe:0 after the decoder cap", () => {
    const args = buildDashVideoArgs({ ...base, encoder: "cpu", quality: "720p", threads: 2, fromStdin: true });
    const inputIdx = args.indexOf("-i");
    expect(args[inputIdx + 1]).toBe("pipe:0");
    expect(args.slice(inputIdx - 2, inputIdx)).toEqual(["-threads", "2"]);
  });
});
