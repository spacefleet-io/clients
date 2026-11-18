import { describe, expect, it } from "vitest";

import {
  getElectronCommandLineSwitches,
  shouldDisableHardwareAcceleration,
  shouldDisableSpellcheck,
} from "../src/main/electronPerformance";

// On failure, dump the env input and the derived switch/flag value so a CI
// failure shows exactly which env→switch mapping regressed, without a repro.
const dumpPerfSnapshot = (
  label: string,
  ctx: { env: Record<string, string>; observed: unknown; expected: unknown }
) => {
  try {
    console.error(`=== [electron-performance:${label}] snapshot ===`);
    console.error(`env=${JSON.stringify(ctx.env)}`);
    console.error(`observed=${JSON.stringify(ctx.observed)}`);
    console.error(`expected=${JSON.stringify(ctx.expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("electron performance switches", () => {
  it("enables hardware acceleration by default, disables only when explicitly requested", () => {
    console.info(`[electron-performance:hw-accel] checking default + explicit 1/0 env values`);
    const cases: Array<{ env: Record<string, string>; expected: boolean }> = [
      { env: {}, expected: false },
      { env: { SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION: "1" }, expected: true },
      { env: { SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION: "0" }, expected: false },
    ];
    for (const c of cases) {
      const observed = shouldDisableHardwareAcceleration(c.env);
      console.info(`[electron-performance:hw-accel] env=${JSON.stringify(c.env)} -> ${observed} (expected ${c.expected})`);
      if (observed !== c.expected) dumpPerfSnapshot("hw-accel", { env: c.env, observed, expected: c.expected });
    }
    expect(shouldDisableHardwareAcceleration({})).toBe(false);
    expect(shouldDisableHardwareAcceleration({ SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION: "1" })).toBe(true);
    expect(shouldDisableHardwareAcceleration({ SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION: "0" })).toBe(false);
  });

  it("disables spellcheck by default for the desktop shell", () => {
    console.info(`[electron-performance:spellcheck] checking default + explicit enable/disable env`);
    const cases: Array<{ env: Record<string, string>; expected: boolean }> = [
      { env: {}, expected: true },
      { env: { SF_ELECTRON_ENABLE_SPELLCHECK: "1" }, expected: false },
      { env: { SF_ELECTRON_DISABLE_SPELLCHECK: "0" }, expected: false },
    ];
    for (const c of cases) {
      const observed = shouldDisableSpellcheck(c.env);
      console.info(`[electron-performance:spellcheck] env=${JSON.stringify(c.env)} -> ${observed} (expected ${c.expected})`);
      if (observed !== c.expected) dumpPerfSnapshot("spellcheck", { env: c.env, observed, expected: c.expected });
    }
    expect(shouldDisableSpellcheck({})).toBe(true);
    expect(shouldDisableSpellcheck({ SF_ELECTRON_ENABLE_SPELLCHECK: "1" })).toBe(false);
    expect(shouldDisableSpellcheck({ SF_ELECTRON_DISABLE_SPELLCHECK: "0" })).toBe(false);
  });

  it("does not force chromium gpu/video switches by default", () => {
    const observed = getElectronCommandLineSwitches({});
    console.info(`[electron-performance:default-switches] empty env -> switches=${JSON.stringify(observed)} (expected [])`);
    if (observed.length !== 0) dumpPerfSnapshot("default-switches", { env: {}, observed, expected: [] });
    expect(getElectronCommandLineSwitches({})).toEqual([]);
  });

  it("enables only explicitly requested switches", () => {
    const env = {
      SF_ELECTRON_ENABLE_GPU_RASTERIZATION: "1",
      SF_ELECTRON_ENABLE_ZERO_COPY: "0",
      SF_ELECTRON_ENABLE_ACCELERATED_VIDEO_DECODE: "1",
    };
    const expected = ["enable-gpu-rasterization", "enable-accelerated-video-decode"];
    const observed = getElectronCommandLineSwitches(env);
    console.info(`[electron-performance:explicit-switches] env=${JSON.stringify(env)} -> ${JSON.stringify(observed)} (expected ${JSON.stringify(expected)})`);
    if (JSON.stringify(observed) !== JSON.stringify(expected))
      dumpPerfSnapshot("explicit-switches", { env, observed, expected });
    expect(getElectronCommandLineSwitches(env)).toEqual(expected);
  });
});
