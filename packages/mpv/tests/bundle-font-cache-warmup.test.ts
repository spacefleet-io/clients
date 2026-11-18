import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as external from "../src/external";
import type { ResolvedExternalMpvTarget } from "../src/external";

/**
 * @bugfix @regression-proof mpv-bundle-fontconfig-cold-scan (#25 P5/B3)
 *
 * The bundled mpv's fontconfig (2.13, cache-7) cannot read a newer host's
 * font caches, so its first OSD setup scanned every system font before the
 * first frame: 1.8 s idle, 17.3 s under load (black backdrop window). Fix:
 * the app warms the bundle's cache headlessly at startup. The launch env must
 * keep the HOST font set (a minimal fonts.conf would drop the CJK/Cyrillic/...
 * fonts text subtitles need).
 */

type Target = ResolvedExternalMpvTarget;
type Plan = { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null;
type PlanFn = (target: Target, base: { env: NodeJS.ProcessEnv; dataDir: string }) => Plan;
// The app passes buildExternalMpvEnv()'s result, which carries dataDir.
type EnvFn = (target: Target, base: { env: NodeJS.ProcessEnv; dataDir?: string }) => NodeJS.ProcessEnv;

const BUNDLE: Target = { bin: "/opt/b/bin/mpv", kind: "bundle", libDirs: ["/opt/b/lib"] };
// The bundle's library dirs on the platform's loader path (Linux: LD_LIBRARY_PATH "/opt/b/lib:<prev>";
// macOS: DYLD_FALLBACK_LIBRARY_PATH; Windows: PATH), as the platform layer composes it.
const bundleLaunchEnv = (env: NodeJS.ProcessEnv) => getDesktopPlatform().binaries.launchEnv(BUNDLE, env);

let dataDir = "";
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "sf-mpv-font-warmup-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("@bugfix @regression-proof bundled mpv font cache warm-up", () => {
  it("plans a headless one-frame bundle run on a local PNG with the bundle's lib dirs", () => {
    const plan = (external as Record<string, unknown>).planMpvBundleFontCacheWarmup as PlanFn | undefined;
    console.info(`[mpv-font-warmup] planMpvBundleFontCacheWarmup exported=${typeof plan}`);
    expect(typeof plan).toBe("function");
    const hostEnv = { PATH: "/usr/bin", LD_LIBRARY_PATH: "/x" };
    const result = plan!(BUNDLE, { env: hostEnv, dataDir });
    console.info(`[mpv-font-warmup] plan=${JSON.stringify(result && { bin: result.bin, args: result.args, env: result.env })}`);
    expect(result).not.toBeNull();
    expect(result!.bin).toBe(BUNDLE.bin);
    expect(result!.args).toEqual(expect.arrayContaining(["--no-config", "--vo=null", "--ao=null", "--frames=1"]));
    const image = result!.args[result!.args.length - 1];
    expect(path.dirname(image)).toBe(dataDir);
    expect(existsSync(image)).toBe(true);
    expect(readFileSync(image).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(result!.env).toEqual(expect.objectContaining(bundleLaunchEnv(hostEnv)));
    expect(Object.values(result!.env).some((value) => value?.includes("/opt/b/lib"))).toBe(true);
    expect(result!.env.FONTCONFIG_FILE).toBeUndefined();
  });

  it("skips non-bundle targets (their fontconfig reads the host caches)", () => {
    const plan = (external as Record<string, unknown>).planMpvBundleFontCacheWarmup as PlanFn | undefined;
    expect(typeof plan).toBe("function");
    const system = plan!({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }, { env: {}, dataDir });
    const fallback = plan!({ bin: "mpv", kind: "fallback", libDirs: [] }, { env: {}, dataDir });
    console.info(`[mpv-font-warmup] system=${JSON.stringify(system)} fallback=${JSON.stringify(fallback)}`);
    expect(system).toBeNull();
    expect(fallback).toBeNull();
  });

  it("launch env keeps the host font set (no FONTCONFIG_FILE override)", () => {
    const buildEnv = (external as Record<string, unknown>).buildExternalMpvTargetEnv as EnvFn | undefined;
    expect(typeof buildEnv).toBe("function");
    const bundle = buildEnv!(BUNDLE, { env: { PATH: "/usr/bin" }, dataDir });
    console.info(`[mpv-font-warmup] bundleEnv=${JSON.stringify(bundle)}`);
    expect(bundle.FONTCONFIG_FILE).toBeUndefined();
    expect(bundle).toEqual(expect.objectContaining(bundleLaunchEnv({ PATH: "/usr/bin" })));
    expect(Object.values(bundle).some((value) => value?.includes("/opt/b/lib"))).toBe(true);
  });
});
