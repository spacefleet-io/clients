/**
 * @test-id INGEST-PREVIEW-SHEETS-HW-001
 * @level unit
 * @why The preview sampling pass decodes every frame of the film; on a computer with a working hardware encoder
 *      that decode and the 160 px scale run on the graphics card (Chris 2026-11-20, ingest audit). Pins:
 *      - the CPU arguments are unchanged (same pictures as before on CPU-only computers),
 *      - the CUDA / VA-API / VideoToolbox argument shapes (decode flags before `-i`, GPU scale chain keeping the
 *        display-aspect height formula, only the small picture downloaded),
 *      - a failed hardware pass reruns on the CPU from an empty frames dir, and the sheets keep their size/layout,
 *      - a cancelled pass never falls back.
 *      ffmpeg is a fake runner here that writes PNG frames; the real-ffmpeg fallback is in
 *      `preview-sheets.integration.test.ts`.
 * @covers packages/ingest-core/src/previewSheets.ts: buildPreviewSampleArgs, generatePreviewSheets
 */
/// <reference path="../src/pngjs.d.ts" />
import { existsSync, mkdtempSync, promises as fs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPreviewSampleArgs, generatePreviewSheets, type PreviewHardwareDecode } from "../src/previewSheets";

const SUITE = "preview-sheets-hardware-decode";
const THREADS = { input: ["-threads", "4"], output: ["-threads", "2"] };
const HEIGHT_EXPR = "'max(2,trunc(160/dar/2)*2)'";

/** The sampling pass's arguments before hardware decode existed: CPU computers must keep getting exactly these. */
const LEGACY_CPU_ARGS = (inputPath: string, framePattern: string) => [
  "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", "warning",
  "-threads", "4",
  "-skip_loop_filter", "all",
  "-i", inputPath,
  "-map", "0:V:0", "-an", "-sn", "-dn",
  "-vf", `scale=160:${HEIGHT_EXPR}:flags=bilinear`,
  "-threads", "2",
  "-r", "1/5", "-c:v", "png", "-f", "image2", framePattern,
];

/** Argument right after `flag`, or undefined. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("preview sampling pass on the graphics card", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-preview-hw-"));
    console.info(`[${SUITE}:setup] root=${root}`);
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the CPU arguments byte-identical", () => {
    const args = buildPreviewSampleArgs({ inputPath: "/in.mkv", framePattern: "/f/%06d.png", threads: THREADS });
    const explicitNull = buildPreviewSampleArgs({ inputPath: "/in.mkv", framePattern: "/f/%06d.png", threads: THREADS, hardware: null });
    console.info(`[${SUITE}:cpu] ${args.join(" ")}`);
    expect(args).toEqual(LEGACY_CPU_ARGS("/in.mkv", "/f/%06d.png"));
    expect(explicitNull).toEqual(args);
  });

  it.each<[string, PreviewHardwareDecode, string[], string]>([
    [
      "cuda",
      { kind: "cuda" },
      ["-init_hw_device", "cuda=sf_preview_cuda", "-filter_hw_device", "sf_preview_cuda", "-hwaccel", "cuda", "-hwaccel_device", "sf_preview_cuda", "-hwaccel_output_format", "cuda"],
      `hwupload,scale_cuda=160:${HEIGHT_EXPR}:interp_algo=bilinear:format=nv12,hwdownload,format=nv12`,
    ],
    [
      "vaapi",
      { kind: "vaapi", device: "/dev/dri/renderD129" },
      ["-vaapi_device", "/dev/dri/renderD129", "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
      `format=nv12|vaapi,hwupload,scale_vaapi=w=160:h=${HEIGHT_EXPR}:mode=fast:format=nv12,hwdownload,format=nv12`,
    ],
    ["videotoolbox", { kind: "videotoolbox" }, ["-hwaccel", "videotoolbox"], `scale=160:${HEIGHT_EXPR}:flags=bilinear`],
  ])("%s: decode flags before -i, scale chain, rest unchanged", (label, hardware, decodeFlags, filter) => {
    const args = buildPreviewSampleArgs({ inputPath: "/in.mkv", framePattern: "/f/%06d.png", threads: THREADS, hardware });
    console.info(`[${SUITE}:${label}] ${args.join(" ")}`);
    const inputAt = args.indexOf("-i");
    const start = args.indexOf(decodeFlags[0]!);
    expect(start, "decode flags present").toBeGreaterThanOrEqual(0);
    expect(args.slice(start, start + decodeFlags.length)).toEqual(decodeFlags);
    expect(start + decodeFlags.length, "decode flags right before the input options").toBeLessThan(inputAt);
    expect(after(args, "-vf")).toBe(filter);
    // Everything but the decode flags and the filter is the CPU recipe (same sampling, same PNG frames).
    const withoutDecode = [...args.slice(0, start), ...args.slice(start + decodeFlags.length)];
    withoutDecode[withoutDecode.indexOf("-vf") + 1] = `scale=160:${HEIGHT_EXPR}:flags=bilinear`;
    expect(withoutDecode).toEqual(LEGACY_CPU_ARGS("/in.mkv", "/f/%06d.png"));
  });

  /** @req META-SKIP-04[runtime] */
  it("cuda: the skip-detection windows scale on the card with nearest sampling, straight to 160x90 grey", () => {
    const args = buildPreviewSampleArgs({
      inputPath: "/in.mkv",
      framePattern: "/f/%06d.png",
      threads: THREADS,
      hardware: { kind: "cuda" },
      skipPicture: { headPattern: "/h/%06d.png", headSeconds: 600, tailPattern: "/t/%06d.png", tailOffsetSeconds: 1000 },
    });
    console.info(`[${SUITE}:cuda-skip] ${args.join(" ")}`);
    const filters = args.flatMap((arg, i) => (arg === "-vf" ? [args[i + 1]] : []));
    // The card's bilinear averages thin credits text away (Parks and Recreation S2E01–E04 lost every credits start);
    // nearest sampling keeps the letters as bright as the CPU path's `fast_bilinear`.
    const skip = "hwupload,scale_cuda=160:90:interp_algo=nearest:format=nv12,hwdownload,format=nv12,format=gray";
    expect(filters).toEqual([`hwupload,scale_cuda=160:${HEIGHT_EXPR}:interp_algo=bilinear:format=nv12,hwdownload,format=nv12`, skip, skip]);
  });

  /** Fake ffmpeg: the sampling pass writes `pictures` PNG frames of `width`x`height`; the sheet pass writes a JPEG stub. */
  const fakeRunner = (opts: { pictures: number; width: number; height: number; failHardware?: Error; emptyHardware?: boolean }) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const output = args[args.length - 1]!;
      if (output.endsWith("%06d.png")) {
        const hardware = args.includes("-hwaccel");
        if (hardware && opts.failHardware) {
          // A partial hardware pass leaves pictures behind, which the CPU rerun must not reuse.
          await fs.writeFile(output.replace("%06d", "000001"), PNG.sync.write(new PNG({ width: 8, height: 8 })));
          throw opts.failHardware;
        }
        if (hardware && opts.emptyHardware) return;
        for (let i = 1; i <= opts.pictures; i += 1) {
          const png = new PNG({ width: opts.width, height: opts.height });
          png.data.fill(i % 256);
          await fs.writeFile(output.replace("%06d", String(i).padStart(6, "0")), PNG.sync.write(png));
        }
        return;
      }
      await fs.mkdir(dirname(output), { recursive: true });
      await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    };
    return { calls, run };
  };

  /** @req INGS-JOBS-08[runtime] */
  it("a failed hardware pass reruns on the CPU from no pictures; sheets keep their size and layout", async () => {
    const workDir = join(root, "work");
    const fake = fakeRunner({ pictures: 150, width: 160, height: 66, failHardware: new Error("ffmpeg exited with code 234: hwaccel init failed") });
    const logs: string[] = [];
    const generated = await generatePreviewSheets({
      inputPath: "/in.mkv",
      workDir,
      durationSeconds: 748,
      run: fake.run,
      threads: THREADS,
      hardware: { kind: "cuda" },
      onLog: (line) => logs.push(line),
    });
    const sampleCalls = fake.calls.filter((args) => args[args.length - 1]!.endsWith("%06d.png"));
    console.info(`[${SUITE}:fallback] sampleCalls=${sampleCalls.length} logs=\n${logs.join("\n")}`);
    if (sampleCalls.length !== 2) console.error(`[${SUITE}:fallback] calls=${JSON.stringify(fake.calls, null, 1)}`);
    expect(sampleCalls).toHaveLength(2);
    expect(sampleCalls[0]).toContain("-hwaccel");
    expect(sampleCalls[1]).toEqual(LEGACY_CPU_ARGS("/in.mkv", join(workDir, "frames", "%06d.png")));
    expect(logs.some((line) => line.includes("cuda decode failed, sampling again on the CPU: ffmpeg exited with code 234"))).toBe(true);
    expect(logs.some((line) => line.includes("sampled pictures=150 decode=cpu"))).toBe(true);
    // The stray 8x8 picture of the failed pass is gone: every picture is 160x66.
    expect(generated.pictureWidth).toBe(160);
    expect(generated.pictureHeight).toBe(66);
    expect(generated.pictureCount).toBe(150);
    expect(generated.sheets.map((s) => [s.firstPicture, s.pictureCount, s.width, s.height])).toEqual([
      [0, 100, 1600, 660],
      [100, 50, 1600, 330],
    ]);
    expect(existsSync(join(workDir, "frames")), "frames removed").toBe(false);
  });

  /** @req INGS-JOBS-08[runtime] */
  it("a hardware pass that exits cleanly with no pictures also reruns on the CPU", async () => {
    const fake = fakeRunner({ pictures: 12, width: 160, height: 90, emptyHardware: true });
    const logs: string[] = [];
    const generated = await generatePreviewSheets({
      inputPath: "/in.mkv",
      workDir: join(root, "work-empty"),
      durationSeconds: 60,
      run: fake.run,
      threads: THREADS,
      hardware: { kind: "cuda" },
      onLog: (line) => logs.push(line),
    });
    console.info(`[${SUITE}:empty] calls=${fake.calls.length} logs=\n${logs.join("\n")}`);
    expect(logs.some((line) => line.includes("cuda decode failed, sampling again on the CPU: no pictures"))).toBe(true);
    expect(generated.pictureCount).toBe(12);
  });

  /** @req INGS-JOBS-08[runtime] */
  it("a working hardware pass runs once and gives the same sheet layout as the CPU", async () => {
    const results = [];
    for (const hardware of [null, { kind: "vaapi", device: "/dev/dri/renderD128" } as const]) {
      const fake = fakeRunner({ pictures: 150, width: 160, height: 66 });
      const logs: string[] = [];
      const generated = await generatePreviewSheets({
        inputPath: "/in.mkv",
        workDir: join(root, `work-${hardware?.kind ?? "cpu"}`),
        durationSeconds: 748,
        run: fake.run,
        threads: THREADS,
        hardware,
        onLog: (line) => logs.push(line),
      });
      const sampleCalls = fake.calls.filter((args) => args[args.length - 1]!.endsWith("%06d.png"));
      console.info(`[${SUITE}:layout] ${hardware?.kind ?? "cpu"} sampleCalls=${sampleCalls.length} ${logs.find((l) => l.includes("sampled"))}`);
      expect(sampleCalls).toHaveLength(1);
      expect(logs.some((line) => line.includes(`decode=${hardware?.kind ?? "cpu"}`))).toBe(true);
      results.push({ ...generated, sheets: generated.sheets.map(({ path: _path, ...rest }) => rest) });
    }
    expect(results[1]).toEqual(results[0]);
  });

  it("a cancelled hardware pass does not fall back to the CPU", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeRunner({ pictures: 10, width: 160, height: 66, failHardware: new Error("aborted") });
    await expect(
      generatePreviewSheets({
        inputPath: "/in.mkv",
        workDir: join(root, "work-abort"),
        durationSeconds: 50,
        run: fake.run,
        threads: THREADS,
        hardware: { kind: "cuda" },
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    console.info(`[${SUITE}:abort] calls=${fake.calls.length}`);
    expect(fake.calls).toHaveLength(1);
  });
});
