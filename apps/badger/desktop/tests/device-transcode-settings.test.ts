/**
 * Per-computer "fallback 360p copy" store (#25, Chris 2026-10-09):
 *  - hardware detection runs once, on the first start of THIS computer;
 *  - until the first-run question is answered, the recommendation applies;
 *  - accept / override store the right value and mark it answered;
 *  - nothing ever re-detects or overrides a value this computer already has.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceSettingsStore } from "../src/main/deviceSettings";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";

const P = "[device-transcode-settings]";

const WEAK: TranscodeHardware = { cpuModel: "Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz", cores: 4, ramGB: 8, hwEncoder: "none" };
const STRONG: TranscodeHardware = { cpuModel: "AMD Ryzen 9 7950X", cores: 32, ramGB: 64, hwEncoder: "vaapi" };

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

const makeStore = (hw: TranscodeHardware, forcedDefault: "on" | "off" | null = null) => {
  const probeHardware = vi.fn(async () => {
    console.info(`${P}:probe probing hardware -> ${JSON.stringify(hw)}`);
    return hw;
  });
  const store = createDeviceSettingsStore({
    filePath,
    probeHardware,
    forcedDefault,
    log: (line) => {
      console.info(`${P}:store-log ${line}`);
      logLines.push(line);
    },
  });
  return { store, probeHardware };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-device-settings-"));
  filePath = join(dir, "device-settings.json");
  logLines = [];
  console.info(`${P}:setup filePath=${filePath}`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("first-start detection", () => {
  it("detects once on a fresh computer; the recommendation applies until answered", async () => {
    const { store, probeHardware } = makeStore(WEAK);
    // Concurrent first callers (dialog + ingest) must share ONE detection.
    const [a, b] = await Promise.all([store.getTranscode(), store.getTranscode()]);
    const c = await store.getTranscode();
    console.info(`${P}:fresh a=${JSON.stringify(a)} probes=${probeHardware.mock.calls.length}`);
    if (probeHardware.mock.calls.length !== 1 || a.fallbackCopy !== false) dumpState("fresh");
    expect(probeHardware).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ fallbackCopy: false, answered: false, answer: null });
    expect(a.recommendation).toMatchObject({ fallbackCopy: false, reason: "weak", hardware: WEAK });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(logLines).toContain("[transcode-default] cores=4 ramGB=8 hwEncoder=none -> fallbackCopy=off (first start)");
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.transcode.recommendation.fallbackCopy).toBe(false);
    expect(persisted.transcode.answered).toBe(false);
  });

  it("a relaunch (new store, same computer) never re-detects, even unanswered", async () => {
    await makeStore(STRONG).store.getTranscode();
    logLines = [];
    const relaunch = makeStore(WEAK);
    const value = await relaunch.store.getTranscode();
    console.info(`${P}:relaunch value=${JSON.stringify(value)} probes=${relaunch.probeHardware.mock.calls.length}`);
    if (relaunch.probeHardware.mock.calls.length !== 0) dumpState("relaunch");
    expect(relaunch.probeHardware).not.toHaveBeenCalled();
    expect(value).toMatchObject({ fallbackCopy: true, answered: false });
    expect(logLines.some((l) => l.includes("detection skipped"))).toBe(true);
  });

  it("an unreadable file counts as 'no value yet' and is re-detected loudly", async () => {
    writeFileSync(filePath, "{not json");
    const { store, probeHardware } = makeStore({ cores: 8, ramGB: 16, hwEncoder: "none" });
    const value = await store.getTranscode();
    console.info(`${P}:corrupt value=${JSON.stringify(value)}`);
    expect(probeHardware).toHaveBeenCalledTimes(1);
    expect(value.recommendation).toMatchObject({ fallbackCopy: true, reason: "strong-cpu" });
    expect(logLines.some((l) => l.includes("unreadable"))).toBe(true);
  });
});

describe("first-run answer", () => {
  it.each([
    ["accepted", WEAK, false],
    ["overridden", WEAK, true],
    ["accepted", STRONG, true],
    ["overridden", STRONG, false],
  ] as const)("%s on %o stores fallbackCopy=%s and marks answered", async (answer, hw, expected) => {
    const { store } = makeStore(hw);
    const settled = await store.answerFirstRun(answer);
    console.info(`${P}:answer ${answer} settled=${JSON.stringify(settled)}`);
    if (settled.fallbackCopy !== expected) dumpState(`answer-${answer}`);
    expect(settled).toMatchObject({ fallbackCopy: expected, answered: true, answer });
    expect(logLines.some((l) => l.includes(`answer=${answer}`))).toBe(true);

    const relaunch = makeStore(hw === WEAK ? STRONG : WEAK);
    const after = await relaunch.store.getTranscode();
    console.info(`${P}:answer ${answer} relaunch=${JSON.stringify(after)}`);
    expect(relaunch.probeHardware).not.toHaveBeenCalled();
    expect(after).toMatchObject({ fallbackCopy: expected, answered: true, answer });
  });

  it("a value an older build stored as 'dismissed' still counts as answered (no re-ask, no re-detection)", async () => {
    const { store: first } = makeStore(WEAK);
    await first.getTranscode();
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as { transcode: Record<string, unknown> };
    writeFileSync(filePath, JSON.stringify({ version: 1, transcode: { ...stored.transcode, answered: true, answer: "dismissed" } }));
    const relaunch = makeStore(STRONG);
    const after = await relaunch.store.getTranscode();
    expect(relaunch.probeHardware).not.toHaveBeenCalled();
    expect(after).toMatchObject({ answered: true, answer: "dismissed", fallbackCopy: false });
  });

  it("a second answer is ignored: the question is asked once", async () => {
    const { store } = makeStore(WEAK);
    await store.answerFirstRun("overridden");
    const again = await store.answerFirstRun("accepted");
    console.info(`${P}:twice again=${JSON.stringify(again)}`);
    expect(again).toMatchObject({ fallbackCopy: true, answer: "overridden" });
  });
});

describe("a device-settings.json written when the copy was called auto480p", () => {
  const legacyFile = (transcode: Record<string, unknown>) => ({
    version: 1,
    transcode,
    uploadsDuringPlayback: {
      mode: "throttle",
      answered: true,
      answer: "chosen",
      recommendation: { mode: "full", reason: "strong-cpu", hardware: STRONG, detectedAt: "2026-10-13T08:00:00.000Z" },
      updatedAt: "2026-10-13T08:05:00.000Z",
    },
  });

  it("an answered value, its answer and its recommendation carry over; the computer is not asked or re-detected", async () => {
    writeFileSync(
      filePath,
      JSON.stringify(
        legacyFile({
          auto480p: true,
          answered: true,
          answer: "overridden",
          recommendation: { auto480p: false, reason: "weak", hardware: WEAK, detectedAt: "2026-10-09T08:00:00.000Z" },
          updatedAt: "2026-10-09T08:05:00.000Z",
        }),
      ),
    );
    const { store, probeHardware } = makeStore(STRONG);
    const after = await store.getTranscode();
    console.info(`${P}:legacy-answered after=${JSON.stringify(after)}`);
    if (probeHardware.mock.calls.length > 0) dumpState("legacy-answered");
    expect(probeHardware).not.toHaveBeenCalled();
    expect(after).toMatchObject({ fallbackCopy: true, answered: true, answer: "overridden", updatedAt: "2026-10-09T08:05:00.000Z" });
    expect(after.recommendation).toMatchObject({ fallbackCopy: false, reason: "weak", hardware: WEAK, detectedAt: "2026-10-09T08:00:00.000Z" });
    expect(logLines.some((l) => l.includes("auto480p") && l.includes("fallbackCopy"))).toBe(true);
  });

  it("is rewritten under the new name once, and the uploads answer is left untouched", async () => {
    writeFileSync(
      filePath,
      JSON.stringify(
        legacyFile({
          auto480p: false,
          answered: true,
          answer: "accepted",
          recommendation: { auto480p: false, reason: "weak", hardware: WEAK, detectedAt: "2026-10-09T08:00:00.000Z" },
          updatedAt: "2026-10-09T08:05:00.000Z",
        }),
      ),
    );
    await makeStore(STRONG).store.getTranscode();
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as {
      transcode: Record<string, unknown> & { recommendation: Record<string, unknown> };
      uploadsDuringPlayback: Record<string, unknown>;
    };
    console.info(`${P}:legacy-rewritten disk=${JSON.stringify(onDisk)}`);
    expect(onDisk.transcode).not.toHaveProperty("auto480p");
    expect(onDisk.transcode.recommendation).not.toHaveProperty("auto480p");
    expect(onDisk.transcode).toMatchObject({ fallbackCopy: false, answered: true, answer: "accepted" });
    expect(onDisk.uploadsDuringPlayback).toMatchObject({ mode: "throttle", answered: true, answer: "chosen" });
  });

  it("an unanswered legacy file stays unanswered and keeps its recommendation", async () => {
    writeFileSync(
      filePath,
      JSON.stringify(
        legacyFile({
          auto480p: true,
          answered: false,
          answer: null,
          recommendation: { auto480p: true, reason: "hw-encoder", hardware: STRONG, detectedAt: "2026-10-09T08:00:00.000Z" },
          updatedAt: "2026-10-09T08:00:00.000Z",
        }),
      ),
    );
    const { store, probeHardware } = makeStore(WEAK);
    const after = await store.getTranscode();
    console.info(`${P}:legacy-unanswered after=${JSON.stringify(after)}`);
    expect(probeHardware).not.toHaveBeenCalled();
    expect(after).toMatchObject({ fallbackCopy: true, answered: false, answer: null });
    expect(after.recommendation).toMatchObject({ fallbackCopy: true, reason: "hw-encoder", hardware: STRONG });
  });
});

describe("Settings change", () => {
  it("is never overridden by detection and counts as answered", async () => {
    const first = makeStore(STRONG);
    expect((await first.store.getTranscode()).fallbackCopy).toBe(true);
    const changed = await first.store.setFallbackCopy(false);
    console.info(`${P}:settings changed=${JSON.stringify(changed)}`);
    expect(changed).toMatchObject({ fallbackCopy: false, answered: true, answer: "settings" });

    const relaunch = makeStore(STRONG);
    const value = await relaunch.store.getTranscode();
    console.info(`${P}:settings relaunch value=${JSON.stringify(value)}`);
    if (value.fallbackCopy !== false) dumpState("settings");
    expect(relaunch.probeHardware).not.toHaveBeenCalled();
    expect(value).toMatchObject({ fallbackCopy: false, answered: true });
  });

  it("a change made while detection is still running wins", async () => {
    let release: (hw: TranscodeHardware) => void = () => undefined;
    const probeHardware = vi.fn(
      () =>
        new Promise<TranscodeHardware>((resolve) => {
          release = resolve;
        }),
    );
    const store = createDeviceSettingsStore({ filePath, probeHardware, forcedDefault: null, log: (l) => logLines.push(l) });
    const pending = store.getTranscode();
    const userSet = store.setFallbackCopy(true);
    release(WEAK);
    await pending;
    await userSet;
    const final = await store.getTranscode();
    console.info(`${P}:race final=${JSON.stringify(final)}`);
    if (final.fallbackCopy !== true) dumpState("race", { final });
    expect(final).toMatchObject({ fallbackCopy: true, answered: true, answer: "settings" });
  });
});

describe("SF_TRANSCODE_FALLBACK_COPY (test harnesses)", () => {
  it("settles a fresh computer without detection or question; stored values still win", async () => {
    const forced = makeStore(STRONG, "off");
    const value = await forced.store.getTranscode();
    console.info(`${P}:forced value=${JSON.stringify(value)}`);
    expect(forced.probeHardware).not.toHaveBeenCalled();
    expect(value).toMatchObject({ fallbackCopy: false, answered: true, answer: "forced" });
    expect(logLines.some((l) => l.includes("fallbackCopy=off") && l.includes("SF_TRANSCODE_FALLBACK_COPY"))).toBe(true);

    await forced.store.setFallbackCopy(true);
    const after = await makeStore(WEAK, "off").store.getTranscode();
    console.info(`${P}:forced relaunch after=${JSON.stringify(after)}`);
    expect(after).toMatchObject({ fallbackCopy: true, answer: "settings" });
  });
});
