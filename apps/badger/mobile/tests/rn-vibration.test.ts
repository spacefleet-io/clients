/**
 * @test-id MOBILE-RN-VIBRATION-001
 * @level unit
 *
 * The phone's tab bar taps `Vibration.vibrate(10)` on every press. react-native-tvos 0.85.3-3 ships a Vibration module
 * that loads its native spec with a bare `require('./NativeVibration')` (an ES module namespace, not the module), so
 * every vibrate call threw "undefined is not a function" and no tab press ever switched tabs. This runs the installed
 * Vibration module the way Metro compiles it and checks a vibrate reaches the native module.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { transformSync } from "@babel/core";
import { describe, expect, it, vi } from "vitest";

const localRequire = createRequire(import.meta.url);

/** Compiles the installed module with the app's Babel preset and runs it with the given stand-ins for its imports. */
const loadVibration = (stubs: Record<string, unknown>) => {
  const file = localRequire.resolve("react-native/Libraries/Vibration/Vibration.js");
  const compiled = transformSync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [localRequire.resolve("@react-native/babel-preset")],
  });
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (id: string) => {
    if (!(id in stubs)) throw new Error(`unexpected import ${id} from ${dirname(file)}`);
    return stubs[id];
  };
  new Function("require", "module", "exports", compiled?.code ?? "")(requireStub, module, module.exports);
  const exported = module.exports.default;
  if (!exported || typeof exported !== "object" || !("vibrate" in exported) || typeof exported.vibrate !== "function") {
    throw new Error("Vibration module has no vibrate()");
  }
  return exported.vibrate;
};

describe("react-native Vibration on a phone", () => {
  // Compiling with the RN Babel preset loads it cold: measured 11 s on a loaded machine, past vitest's 5 s default.
  it("a short vibrate reaches the native module instead of throwing", { timeout: 30_000 }, () => {
    const nativeVibrate = vi.fn();
    // What Metro hands the module for `./NativeVibration`: a compiled ES module whose default export is the native module.
    const nativeModule = { __esModule: true, default: { vibrate: nativeVibrate, getConstants: () => ({}) } };
    const vibrate = loadVibration({
      "./NativeVibration": nativeModule,
      "../Utilities/Platform": { __esModule: true, default: { OS: "android", isTV: false } },
    });
    expect(() => vibrate(10)).not.toThrow();
    expect(nativeVibrate).toHaveBeenCalledWith(10);
  });
});
