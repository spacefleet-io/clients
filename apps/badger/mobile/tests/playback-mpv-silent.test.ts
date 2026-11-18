/**
 * @test-id MOBILE-PLAYBACK-MPV-SILENT-001
 * @level unit
 *
 * Why exists: REL-ENV-36 — a test launch never makes sound. The Apple TV UI tests also run on a physical Apple TV,
 * whose audio goes to a real TV, so the iOS/tvOS mpv engine must honour SF_SILENT on a device too (not only
 * under `targetEnvironment(simulator)` like SB_MPV_AO): `ao=null` and `mute=yes`. The UI tests pass SF_SILENT=1 to the
 * app through TV_E2E_LAUNCH_ENV (scripts/test-all-clients/apple-host.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const engine = readFileSync(resolve(__dirname, "../../../../packages/mobile-mpv-playback/ios/Player/MpvEngine.swift"), "utf8");
const uiTests = readFileSync(resolve(__dirname, "../e2e-tv/apple-tv/SpaceBadgerTVUITests/SpaceBadgerTVUITests.swift"), "utf8");

describe("the iOS / tvOS mpv engine is silent under SF_SILENT", () => {
  it("SF_SILENT selects ao=null before the simulator-only override, outside any #if", () => {
    const body = engine.slice(engine.indexOf("private static let audioOutput"), engine.indexOf("init(layer: CAMetalLayer)"));
    const silent = body.indexOf('if silent { return "null" }');
    const simOnly = body.indexOf("#if targetEnvironment(simulator)");
    console.info("[playback-mpv-silent] silent branch at", silent, "simulator block at", simOnly);
    expect(silent).toBeGreaterThan(-1);
    expect(simOnly).toBeGreaterThan(silent);
  });

  it("mute follows SF_SILENT, and only 0/false/no keep the sound", () => {
    expect(engine).toContain('("mute", Self.silent ? "yes" : "no")');
    expect(engine).toContain('env["SF_SILENT"]');
    expect(engine).toContain('["0", "false", "no"]');
    expect(engine).toContain("mpv.silent ao=null mute=yes");
  });

  it("the Apple TV UI tests hand the host's launch environment to the app", () => {
    expect(uiTests).toContain('env["TV_E2E_LAUNCH_ENV"]');
    expect(uiTests).toContain("app.launchEnvironment.merge(vars)");
  });
});
