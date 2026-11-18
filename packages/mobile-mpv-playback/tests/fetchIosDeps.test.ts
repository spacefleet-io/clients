/**
 * @test-id MPV-DEPS-001
 * @level unit
 * @why One pod serves the iPhone and the Apple TV app (MPV-TV-01), on devices and on the Xcode simulators the older-OS
 *   and Apple TV tests run on (REL-MOB-02, REL-TV-03): `fetch-ios-deps.ts` must pick the media-deps target from
 *   `--target` (iPhone by default, so the iPhone Podfile's bare call keeps working), fetch its simulator twin too, read
 *   the local-build override of each bundle only, never let an iPhone override feed the Apple TV vendor dir (or a device
 *   override feed the simulator, or the reverse), and vendor ONE xcframework per library holding both slices.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JOINED_STAMP, defaultLocalDir, joinSlices, localSource, platformOf, simulatorOf, targetFromArgs } from "../scripts/fetch-ios-deps";

describe("fetch-ios-deps target selection", () => {
  it("defaults to the iPhone target and accepts tvos-arm64", () => {
    expect(targetFromArgs([])).toBe("ios-arm64");
    expect(targetFromArgs(["--local"])).toBe("ios-arm64");
    expect(targetFromArgs(["--target", "tvos-arm64", "--local"])).toBe("tvos-arm64");
  });

  it("refuses an unknown or missing target, and simulator ids as --target (the simulator rides along)", () => {
    expect(() => targetFromArgs(["--target", "android-arm64"])).toThrow(/unknown_target:android-arm64/);
    expect(() => targetFromArgs(["--target", "ios-arm64-simulator"])).toThrow(/unknown_target:ios-arm64-simulator/);
    expect(() => targetFromArgs(["--target"])).toThrow(/unknown_target:/);
  });

  it("pairs each device target with its simulator twin and its joined vendor dir", () => {
    expect(simulatorOf("ios-arm64")).toBe("ios-arm64-simulator");
    expect(simulatorOf("tvos-arm64")).toBe("tvos-arm64-simulator");
    expect(platformOf("ios-arm64")).toBe("ios");
    expect(platformOf("tvos-arm64")).toBe("tvos");
  });

  it("--local defaults to the target's own media-deps output", () => {
    expect(localSource(["--local"], {}, "tvos-arm64")).toBe(defaultLocalDir("tvos-arm64"));
    expect(defaultLocalDir("tvos-arm64").endsWith(path.join("packages", "media-deps", "out", "tvos-arm64"))).toBe(true);
    expect(localSource(["--local", "/x/bundle"], {}, "ios-arm64")).toBe(path.resolve("/x/bundle"));
    expect(localSource(["--local", "--target", "tvos-arm64"], {}, "tvos-arm64")).toBe(defaultLocalDir("tvos-arm64"));
  });

  it("--local feeds only the device bundle, --local-simulator only the simulator bundle", () => {
    expect(localSource(["--local"], {}, "ios-arm64-simulator")).toBeNull();
    expect(localSource(["--local-simulator"], {}, "ios-arm64")).toBeNull();
    expect(localSource(["--local-simulator"], {}, "ios-arm64-simulator")).toBe(defaultLocalDir("ios-arm64-simulator"));
    expect(localSource(["--local", "/dev", "--local-simulator", "/sim"], {}, "tvos-arm64-simulator")).toBe(path.resolve("/sim"));
    expect(localSource(["--local", "/dev", "--local-simulator", "/sim"], {}, "tvos-arm64")).toBe(path.resolve("/dev"));
  });

  it("reads only the bundle's own env override", () => {
    const env = { SB_MEDIA_DEPS_IOS_LOCAL: "/ios/bundle" };
    expect(localSource([], env, "ios-arm64")).toBe(path.resolve("/ios/bundle"));
    expect(localSource([], env, "ios-arm64-simulator")).toBeNull();
    expect(localSource([], env, "tvos-arm64")).toBeNull();
    expect(localSource([], { SB_MEDIA_DEPS_TVOS_LOCAL: "1" }, "tvos-arm64")).toBe(defaultLocalDir("tvos-arm64"));
    expect(localSource([], { SB_MEDIA_DEPS_TVOS_LOCAL: "0" }, "tvos-arm64")).toBeNull();
    expect(localSource([], { SB_MEDIA_DEPS_IOS_SIMULATOR_LOCAL: "1" }, "ios-arm64-simulator")).toBe(defaultLocalDir("ios-arm64-simulator"));
    expect(localSource([], { SB_MEDIA_DEPS_IOS_SIMULATOR_LOCAL: "1" }, "ios-arm64")).toBeNull();
  });
});

// Real xcodebuild on a tiny framework per slice: proves the vendored xcframework carries both slices (macOS only).
// xcodebuild takes seconds per call, more on a busy build host.
describe.runIf(process.platform === "darwin")("fetch-ios-deps joins device + simulator slices", { timeout: 120_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A one-slice `Tiny.xcframework` built for `target` (e.g. arm64-apple-ios15.1-simulator), like a media-deps bundle. */
  const bundle = (root: string, label: string, sdk: string, target: string) => {
    const stage = path.join(root, `${label}-stage`, "Tiny.framework");
    mkdirSync(stage, { recursive: true });
    const source = path.join(root, `${label}.c`);
    writeFileSync(source, "int tiny(void) { return 1; }\n");
    const sdkPath = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync("xcrun", ["--sdk", sdk, "clang", "-target", target, "-isysroot", sdkPath, "-dynamiclib", "-install_name", "@rpath/Tiny.framework/Tiny", "-o", path.join(stage, "Tiny"), source]);
    writeFileSync(
      path.join(stage, "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Tiny</string>' +
        "<key>CFBundleIdentifier</key><string>io.spacefleet.tiny</string><key>CFBundlePackageType</key><string>FMWK</string></dict></plist>",
    );
    const dir = path.join(root, label);
    mkdirSync(dir);
    execFileSync("xcodebuild", ["-create-xcframework", "-framework", stage, "-output", path.join(dir, "Tiny.xcframework")], { stdio: "ignore" });
    return dir;
  };

  it("vendors one xcframework per library with the device and the simulator slice, rebuilt only when a recipe moves", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fetch-ios-deps-join-"));
    dirs.push(root);
    const device = { dir: bundle(root, "device", "iphoneos", "arm64-apple-ios15.1"), recipeHash: "d".repeat(64) };
    const simulator = { dir: bundle(root, "simulator", "iphonesimulator", "arm64-apple-ios15.1-simulator"), recipeHash: "s".repeat(64) };
    const dest = path.join(root, "vendor", "ios");
    const lines: string[] = [];
    const log = (line: string) => {
      console.info(line);
      lines.push(line);
    };

    expect(joinSlices(device, simulator, dest, log)).toBe("joined");
    const slices = readdirSync(path.join(dest, "Tiny.xcframework")).filter((entry) => !entry.endsWith(".plist")).sort();
    console.info(`[fetch-ios-deps.test] joined slices: ${slices.join(" ")}`);
    expect(slices).toEqual(["ios-arm64", "ios-arm64-simulator"]);
    const plist = readFileSync(path.join(dest, "Tiny.xcframework", "Info.plist"), "utf8");
    expect(plist).toContain("<string>simulator</string>");
    expect(readFileSync(path.join(dest, JOINED_STAMP), "utf8")).toBe(`${device.recipeHash} ${simulator.recipeHash}\n`);

    expect(joinSlices(device, simulator, dest, log)).toBe("current");
    expect(joinSlices(device, { ...simulator, recipeHash: "t".repeat(64) }, dest, log)).toBe("joined");
    expect(lines.some((line) => line.includes("already joins"))).toBe(true);
  });

  it("refuses bundles whose library sets differ", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fetch-ios-deps-join-"));
    dirs.push(root);
    const device = { dir: bundle(root, "device", "iphoneos", "arm64-apple-ios15.1"), recipeHash: "d".repeat(64) };
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    expect(() => joinSlices(device, { dir: empty, recipeHash: "s".repeat(64) }, path.join(root, "out"))).toThrow(/slice_mismatch/);
  });
});
