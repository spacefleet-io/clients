/**
 * First-start default for "uploads while a video plays" (#25, Chris 2026-10-13):
 * full speed / throttle / pause, derived from this computer's hardware.
 * Pure functions — no Electron, no ffmpeg.
 *
 * @bugfix @regression-proof
 */
import { describe, expect, it } from "vitest";
import {
  UPLOADS_FULL_MIN_CORES,
  UPLOADS_FULL_MIN_RAM_GB,
  UPLOADS_PAUSE_MAX_CORES,
  UPLOADS_PAUSE_BELOW_RAM_GB,
  decideUploadsDuringPlayback,
  uploadsDuringPlaybackForAnswer,
  uploadsDuringPlaybackReason,
  type UploadsDuringPlayback,
} from "../src/shared/uploadPlaybackDefault";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";

const P = "[upload-playback-default-rule]";

describe("decideUploadsDuringPlayback", () => {
  console.info(
    `${P} thresholds full: cores>=${UPLOADS_FULL_MIN_CORES} && ramGB>=${UPLOADS_FULL_MIN_RAM_GB}; pause: cores<=${UPLOADS_PAUSE_MAX_CORES} || ramGB<${UPLOADS_PAUSE_BELOW_RAM_GB}; else throttle`,
  );

  const table: Array<[string, TranscodeHardware, UploadsDuringPlayback]> = [
    // The reference low-end box of issue #25: 4-core i5, 8-16 GB, no GPU.
    ["reference 4c/8GB (7.7 GiB usable)", { cores: 4, ramGB: 7.7, hwEncoder: "none" }, "throttle"],
    ["reference 4c/16GB", { cores: 4, ramGB: 16, hwEncoder: "none" }, "throttle"],
    ["4c/8GB with hardware encoder (the encoder does not help uploads)", { cores: 4, ramGB: 8, hwEncoder: "vaapi" }, "throttle"],
    ["2c/4t laptop i5 reports 4 logical", { cores: 4, ramGB: 8, hwEncoder: "none" }, "throttle"],
    ["2c no HT / 8GB", { cores: 2, ramGB: 8, hwEncoder: "none" }, "pause"],
    ["1c", { cores: 1, ramGB: 16, hwEncoder: "none" }, "pause"],
    ["8c/4GB", { cores: 8, ramGB: 4, hwEncoder: "none" }, "pause"],
    ["8c/5.9GB (just under the RAM floor)", { cores: 8, ramGB: 5.9, hwEncoder: "none" }, "pause"],
    ["4c/6GB (RAM floor exact)", { cores: 4, ramGB: 6, hwEncoder: "none" }, "throttle"],
    ["8c/12GB (both full floors exact)", { cores: 8, ramGB: 12, hwEncoder: "none" }, "full"],
    ["16c/32GB", { cores: 16, ramGB: 32, hwEncoder: "vaapi" }, "full"],
    ["8c/11.9GB (RAM just under full)", { cores: 8, ramGB: 11.9, hwEncoder: "none" }, "throttle"],
    ["7c/64GB (cores just under full)", { cores: 7, ramGB: 64, hwEncoder: "none" }, "throttle"],
    ["3c/16GB", { cores: 3, ramGB: 16, hwEncoder: "none" }, "throttle"],
  ];

  it.each(table)("%s", (label, hw, expected) => {
    const verdict = decideUploadsDuringPlayback(hw);
    console.info(`${P}:table ${label} ${JSON.stringify(hw)} -> ${verdict} (expected ${expected})`);
    if (verdict !== expected) console.error(`=== ${P}:table-mismatch ${JSON.stringify({ label, hw, verdict, expected })} ===`);
    expect(verdict).toBe(expected);
  });

  it("reason agrees with the verdict, and names why in plain buckets", () => {
    const cases: Array<[TranscodeHardware, string]> = [
      [{ cores: 16, ramGB: 32, hwEncoder: "none" }, "strong"],
      [{ cores: 4, ramGB: 8, hwEncoder: "none" }, "modest"],
      [{ cores: 2, ramGB: 8, hwEncoder: "none" }, "weak"],
      [{ cores: 8, ramGB: 4, hwEncoder: "none" }, "weak"],
    ];
    for (const [hw, reason] of cases) {
      console.info(`${P}:reason ${JSON.stringify(hw)} -> ${uploadsDuringPlaybackReason(hw)}`);
      expect(uploadsDuringPlaybackReason(hw)).toBe(reason);
    }
  });
});

describe("uploadsDuringPlaybackForAnswer", () => {
  it("accepting keeps the recommendation", () => {
    expect(uploadsDuringPlaybackForAnswer("throttle", { kind: "accepted" })).toBe("throttle");
  });

  it("choosing another value stores exactly that value", () => {
    expect(uploadsDuringPlaybackForAnswer("throttle", { kind: "chosen", mode: "full" })).toBe("full");
    expect(uploadsDuringPlaybackForAnswer("throttle", { kind: "chosen", mode: "pause" })).toBe("pause");
  });
});
