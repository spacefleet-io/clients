/**
 * Per-computer "uploads while a video plays" store (#25, Chris 2026-10-13):
 *  - recommendation derived from the hardware, detected ONCE together with the fallback-copy one;
 *  - until the first-run question is answered, the recommendation applies;
 *  - accept / choose another / close store the right value and mark it answered;
 *  - an install that already answered the fallback-copy question is asked the NEW question once,
 *    without a second hardware probe and without touching its fallback-copy answer;
 *  - a Settings change is stored, survives a restart and notifies listeners (live effect);
 *  - SF_UPLOADS_DURING_PLAYBACK settles test harnesses without a dialog.
 *
 * @bugfix @regression-proof
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceSettingsStore, parseForcedUploadsDuringPlayback } from "../src/main/deviceSettings";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";
import type { UploadsDuringPlayback } from "../src/shared/uploadPlaybackDefault";

const P = "[device-uploads-playback-settings]";

const REFERENCE: TranscodeHardware = { cpuModel: "Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz", cores: 4, ramGB: 7.7, hwEncoder: "none" };
const STRONG: TranscodeHardware = { cpuModel: "AMD Ryzen 9 7950X", cores: 32, ramGB: 64, hwEncoder: "vaapi" };
const WEAK: TranscodeHardware = { cpuModel: "Intel(R) Celeron(R) N3050", cores: 2, ramGB: 4, hwEncoder: "none" };

let dir = "";
let filePath = "";
let logLines: string[] = [];

const dumpState = (label: string, extra: Record<string, unknown> = {}) => {
  try {
    const raw = existsSync(filePath) ? readFileSync(filePath, "utf8") : "(missing)";
    console.error(`=== ${P}:${label} snapshot ===`);
    console.error(`file ${filePath}:\n${raw}`);
    console.error(`log lines:\n${logLines.join("\n")}`);
    console.error(`extra: ${JSON.stringify(extra, null, 2)}`);
    console.error(`=== ${P}:${label} end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const makeStore = (
  hw: TranscodeHardware,
  forced: { transcode?: "on" | "off" | null; uploads?: UploadsDuringPlayback | null } = {},
) => {
  const probeHardware = vi.fn(async () => {
    console.info(`${P}:probe probing hardware -> ${JSON.stringify(hw)}`);
    return hw;
  });
  const store = createDeviceSettingsStore({
    filePath,
    probeHardware,
    forcedDefault: forced.transcode ?? null,
    forcedUploadsDuringPlayback: forced.uploads ?? null,
    log: (line) => {
      console.info(`${P}:store-log ${line}`);
      logLines.push(line);
    },
  });
  return { store, probeHardware };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-device-uploads-"));
  filePath = join(dir, "device-settings.json");
  logLines = [];
  console.info(`${P}:setup filePath=${filePath}`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// #928: startup arms the upload policy at once only when reading the mode cannot run the hardware probe.
describe("uploadsDuringPlaybackNeedsDetection", () => {
  it("is true on a first start, false while and after detecting, false once stored or forced", async () => {
    const { store, probeHardware } = makeStore(WEAK);
    expect(store.uploadsDuringPlaybackNeedsDetection()).toBe(true);
    expect(probeHardware).not.toHaveBeenCalled();
    const reading = store.getUploadsDuringPlayback();
    expect(store.uploadsDuringPlaybackNeedsDetection()).toBe(false);
    await reading;
    expect(store.uploadsDuringPlaybackNeedsDetection()).toBe(false);
    expect(makeStore(WEAK).store.uploadsDuringPlaybackNeedsDetection()).toBe(false);
    rmSync(filePath, { force: true });
    const forced = makeStore(WEAK, { uploads: "pause" });
    expect(forced.store.uploadsDuringPlaybackNeedsDetection()).toBe(false);
    await forced.store.getUploadsDuringPlayback();
    expect(forced.probeHardware).not.toHaveBeenCalled();
  });
});

describe("first-start recommendation", () => {
  it.each<[string, TranscodeHardware, UploadsDuringPlayback]>([
    ["reference low-end box", REFERENCE, "throttle"],
    ["strong box", STRONG, "full"],
    ["weak box", WEAK, "pause"],
  ])("%s: recommends from hardware, applies until answered, one probe shared with the fallback copy", async (label, hw, expected) => {
    const { store, probeHardware } = makeStore(hw);
    const [uploads, transcode] = await Promise.all([store.getUploadsDuringPlayback(), store.getTranscode()]);
    const again = await store.getUploadsDuringPlayback();
    console.info(`${P}:fresh ${label} uploads=${JSON.stringify(uploads)} probes=${probeHardware.mock.calls.length}`);
    if (uploads.mode !== expected || probeHardware.mock.calls.length !== 1) dumpState("fresh", { label });
    expect(probeHardware).toHaveBeenCalledTimes(1);
    expect(uploads).toMatchObject({ mode: expected, answered: false, answer: null });
    expect(uploads.recommendation).toMatchObject({ mode: expected, hardware: hw });
    expect(again).toEqual(uploads);
    expect(transcode.answered).toBe(false);
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.uploadsDuringPlayback.mode).toBe(expected);
    expect(persisted.transcode.recommendation.hardware).toEqual(hw);
    expect(logLines.some((l) => l.startsWith("[uploads-playback-default] cores="))).toBe(true);
  });
});

describe("first-run answers", () => {
  it("accepting keeps the recommendation and marks answered", async () => {
    const { store } = makeStore(REFERENCE);
    const answered = await store.answerUploadsFirstRun({ kind: "accepted" });
    console.info(`${P}:accept ${JSON.stringify(answered)}`);
    expect(answered).toMatchObject({ mode: "throttle", answered: true, answer: "accepted" });
  });

  it("choosing another value stores exactly it", async () => {
    const { store } = makeStore(REFERENCE);
    const answered = await store.answerUploadsFirstRun({ kind: "chosen", mode: "pause" });
    expect(answered).toMatchObject({ mode: "pause", answered: true, answer: "chosen" });
    expect(answered.recommendation.mode).toBe("throttle");
  });

  it("a second answer is ignored (asked once)", async () => {
    const { store } = makeStore(REFERENCE);
    await store.answerUploadsFirstRun({ kind: "chosen", mode: "full" });
    const second = await store.answerUploadsFirstRun({ kind: "chosen", mode: "pause" });
    expect(second).toMatchObject({ mode: "full", answer: "chosen" });
    expect(logLines.some((l) => l.includes("ignored: already answered"))).toBe(true);
  });

  it("the answer survives a restart (new store on the same file) with no new probe", async () => {
    const first = makeStore(REFERENCE);
    await first.store.answerUploadsFirstRun({ kind: "chosen", mode: "pause" });
    const second = makeStore(STRONG);
    const reloaded = await second.store.getUploadsDuringPlayback();
    console.info(`${P}:restart ${JSON.stringify(reloaded)} probes=${second.probeHardware.mock.calls.length}`);
    if (reloaded.mode !== "pause") dumpState("restart");
    expect(reloaded).toMatchObject({ mode: "pause", answered: true, answer: "chosen" });
    expect(second.probeHardware).not.toHaveBeenCalled();
  });
});

describe("Settings changes", () => {
  it("stores the value, counts as answered, and notifies listeners right away (live effect)", async () => {
    const { store } = makeStore(REFERENCE);
    const seen: UploadsDuringPlayback[] = [];
    store.onUploadsDuringPlaybackChange((s) => seen.push(s.mode));
    await store.setUploadsDuringPlayback("pause");
    await store.setUploadsDuringPlayback("full");
    const current = await store.getUploadsDuringPlayback();
    console.info(`${P}:settings seen=${JSON.stringify(seen)} current=${JSON.stringify(current)}`);
    expect(seen).toEqual(["pause", "full"]);
    expect(current).toMatchObject({ mode: "full", answered: true, answer: "settings" });
    expect(JSON.parse(readFileSync(filePath, "utf8")).uploadsDuringPlayback.mode).toBe("full");
  });

  it("does not notify when the value did not change", async () => {
    const { store } = makeStore(REFERENCE);
    await store.setUploadsDuringPlayback("throttle");
    const listener = vi.fn();
    store.onUploadsDuringPlaybackChange(listener);
    await store.setUploadsDuringPlayback("throttle");
    expect(listener).not.toHaveBeenCalled();
  });

  it("the unsubscribe function stops notifications", async () => {
    const { store } = makeStore(REFERENCE);
    const listener = vi.fn();
    const off = store.onUploadsDuringPlaybackChange(listener);
    off();
    await store.setUploadsDuringPlayback("pause");
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects a value that is not full/throttle/pause", async () => {
    const { store } = makeStore(REFERENCE);
    // @ts-expect-error deliberately invalid
    await expect(store.setUploadsDuringPlayback("turbo")).rejects.toThrow(/invalid/i);
  });
});

describe("an install that already answered the fallback-copy question", () => {
  const writeLegacy = (hardware: TranscodeHardware | null) => {
    const legacy = {
      version: 1,
      transcode: {
        fallbackCopy: false,
        answered: true,
        answer: "accepted",
        recommendation: { fallbackCopy: false, reason: hardware ? "weak" : null, hardware, detectedAt: "2026-10-09T10:00:00.000Z" },
        updatedAt: "2026-10-09T10:01:00.000Z",
      },
    };
    writeFileSync(filePath, JSON.stringify(legacy, null, 2));
    return legacy;
  };

  it("is asked the new question once, derived from the stored hardware, with no new probe", async () => {
    const legacy = writeLegacy(REFERENCE);
    const { store, probeHardware } = makeStore(STRONG);
    const uploads = await store.getUploadsDuringPlayback();
    const transcode = await store.getTranscode();
    console.info(`${P}:legacy uploads=${JSON.stringify(uploads)} probes=${probeHardware.mock.calls.length}`);
    if (uploads.answered || probeHardware.mock.calls.length !== 0) dumpState("legacy");
    expect(probeHardware).not.toHaveBeenCalled();
    expect(uploads).toMatchObject({ mode: "throttle", answered: false, answer: null });
    // The fallback-copy answer is untouched.
    expect(transcode).toEqual(legacy.transcode);
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.transcode).toEqual(legacy.transcode);
    expect(persisted.uploadsDuringPlayback.answered).toBe(false);
  });

  it("probes once when the stored fallback-copy answer has no hardware (forced earlier)", async () => {
    writeLegacy(null);
    const { store, probeHardware } = makeStore(WEAK);
    const uploads = await store.getUploadsDuringPlayback();
    expect(probeHardware).toHaveBeenCalledTimes(1);
    expect(uploads).toMatchObject({ mode: "pause", answered: false });
  });

  it("answering the new question leaves the fallback-copy answer alone", async () => {
    const legacy = writeLegacy(REFERENCE);
    const { store } = makeStore(REFERENCE);
    await store.answerUploadsFirstRun({ kind: "chosen", mode: "full" });
    expect(JSON.parse(readFileSync(filePath, "utf8")).transcode).toEqual(legacy.transcode);
  });
});

describe("SF_UPLOADS_DURING_PLAYBACK", () => {
  it.each([
    ["full", "full"],
    ["THROTTLE", "throttle"],
    [" pause ", "pause"],
    ["turbo", null],
    ["", null],
    [undefined, null],
  ])("parses %j -> %j", (raw, expected) => {
    expect(parseForcedUploadsDuringPlayback(raw)).toBe(expected);
  });

  it("settles a fresh computer without a probe, answered, so no dialog shows", async () => {
    const { store, probeHardware } = makeStore(REFERENCE, { uploads: "full" });
    const uploads = await store.getUploadsDuringPlayback();
    console.info(`${P}:forced ${JSON.stringify(uploads)} probes=${probeHardware.mock.calls.length}`);
    expect(uploads).toMatchObject({ mode: "full", answered: true, answer: "forced" });
    expect(uploads.recommendation).toMatchObject({ mode: "full", reason: null, hardware: null });
  });

  it("a stored value still wins over the forced one", async () => {
    const first = makeStore(REFERENCE);
    await first.store.setUploadsDuringPlayback("pause");
    const second = makeStore(REFERENCE, { uploads: "full" });
    expect((await second.store.getUploadsDuringPlayback()).mode).toBe("pause");
  });
});

describe("a malformed uploads entry", () => {
  it("is treated as not yet asked (re-derived), never crashes, and keeps the fallback-copy answer", async () => {
    const legacy = {
      version: 1,
      transcode: {
        fallbackCopy: true,
        answered: true,
        answer: "accepted",
        recommendation: { fallbackCopy: true, reason: "hw-encoder", hardware: STRONG, detectedAt: "2026-10-09T10:00:00.000Z" },
        updatedAt: "2026-10-09T10:01:00.000Z",
      },
      uploadsDuringPlayback: { mode: "turbo" },
    };
    writeFileSync(filePath, JSON.stringify(legacy));
    const { store } = makeStore(REFERENCE);
    const uploads = await store.getUploadsDuringPlayback();
    expect(uploads).toMatchObject({ mode: "full", answered: false });
    expect(JSON.parse(readFileSync(filePath, "utf8")).transcode).toEqual(legacy.transcode);
    expect(logLines.some((l) => l.includes("uploadsDuringPlayback entry malformed"))).toBe(true);
  });
});
