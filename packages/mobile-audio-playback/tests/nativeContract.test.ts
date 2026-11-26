import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The JS wrapper, Android's AudioPlaybackModule.kt and the iPhone's AudioPlaybackModule.m/.swift are one contract.
// A method the JS calls that a platform lacks is an "undefined is not a function" on a tap; a state field a platform
// never sends leaves the player screen wrong there (e.g. no `suppressed`: the button shows pause during a call).
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

const js = read("src/index.ts");
const kotlin = read("android/src/main/java/com/spacefleet/audioplayback/AudioPlaybackModule.kt");
const objc = read("ios/AudioPlayback/AudioPlaybackModule.m");
const swiftModule = read("ios/AudioPlayback/AudioPlaybackModule.swift");
const swiftPlayer = read("ios/AudioPlayback/AudioPlayer.swift");

/** The members of `type <name> = { ... };` in src/index.ts. */
const typeMembers = (name: string): string[] => {
  const body = js.match(new RegExp(`type ${name} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
  if (!body) throw new Error(`type ${name} not found in src/index.ts`);
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
};

const methods = typeMembers("NativeAudioPlayback");
const stateFields = typeMembers("AudioPlaybackState");
const itemFields = typeMembers("AudioQueueItem");

describe("native module contract (PAR-PLAY-01)", () => {
  test("the wrappers read the parsed types", () => {
    console.info("[contract] parsed", { methods, stateFields, itemFields });
    expect(methods).toContain("setQueue");
    expect(stateFields).toContain("suppressed");
    expect(itemFields).toContain("gainDb");
  });

  test("Android and iPhone both register the module name and event the JS uses", () => {
    const kotlinName = kotlin.match(/const val NAME = "(\w+)"/)?.[1];
    const kotlinEvent = kotlin.match(/const val STATE_EVENT = "(\w+)"/)?.[1];
    const objcName = objc.match(/RCT_EXTERN_MODULE\s*\((\w+),/)?.[1];
    const swiftEvent = swiftModule.match(/static let stateEvent = "(\w+)"/)?.[1];
    const jsName = js.match(/NativeModules\.(\w+)/)?.[1];
    const jsEvent = js.match(/addListener\("(\w+)"/)?.[1];
    console.info("[contract] names", { jsName, kotlinName, objcName, jsEvent, kotlinEvent, swiftEvent });
    expect(kotlinName).toBe(jsName);
    expect(objcName).toBe(jsName);
    expect(kotlinEvent).toBe(jsEvent);
    expect(swiftEvent).toBe(jsEvent);
  });

  test("every method the JS calls is a native method on Android and on the iPhone", () => {
    const kotlinMethods = [...kotlin.matchAll(/@ReactMethod\s+fun (\w+)\(/g)].map((m) => m[1]);
    const objcMethods = [...objc.matchAll(/RCT_EXTERN_METHOD\((\w+)\s*:/g)].map((m) => m[1]);
    const missing = {
      android: methods.filter((m) => !kotlinMethods.includes(m)),
      ios: methods.filter((m) => !objcMethods.includes(m)),
    };
    console.info("[contract] methods", { methods, kotlinMethods, objcMethods, missing });
    expect(missing).toEqual({ android: [], ios: [] });
  });

  test("every state field the player screen reads is sent by both platforms", () => {
    const kotlinFields = [...kotlin.matchAll(/put(?:String|Boolean|Double|Int|Null)\(\s*"(\w+)"/g)].map((m) => m[1]);
    const swiftFields = [...swiftPlayer.matchAll(/^\s*"(\w+)":/gm)].map((m) => m[1]);
    const missing = {
      android: stateFields.filter((f) => !kotlinFields.includes(f)),
      ios: stateFields.filter((f) => !swiftFields.includes(f)),
    };
    console.info("[contract] state", { stateFields, kotlinFields, swiftFields, missing });
    expect(missing).toEqual({ android: [], ios: [] });
  });

  test("every queue item field the JS sends is read by both platforms", () => {
    const kotlinRead = [...kotlin.matchAll(/item\.(?:getString|optString|getDouble|has)\("(\w+)"\)/g)].map((m) => m[1]);
    const swiftRead = [
      ...[...swiftPlayer.matchAll(/item\["(\w+)"\]/g)].map((m) => m[1]),
      ...[...swiftPlayer.matchAll(/nonEmpty\("(\w+)"\)/g)].map((m) => m[1]),
    ];
    const missing = {
      android: itemFields.filter((f) => !kotlinRead.includes(f)),
      ios: itemFields.filter((f) => !swiftRead.includes(f)),
    };
    console.info("[contract] items", { itemFields, kotlinRead, swiftRead, missing });
    expect(missing).toEqual({ android: [], ios: [] });
  });
});
