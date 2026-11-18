import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExternalMpvArgs, resolveMpvTog4in1Script, resolveMpvTog4in1FontsDir } from "@space/mpv";

const readSource = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

/**
 * @test-id DESKTOP-MPV-OSC-001
 * @level source-contract
 * @bugfix
 * @regression-proof Fails if tog4in1 OSC loading is gated behind an env var or the
 *   script file doesn't exist at the resolved path.
 */
// On a contract miss, dump the resolved paths / arg list so a missing script,
// stray env gate, or absent --osd-fonts-dir flag is diagnosable from the log.
const dumpMpvOscSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-osc-loading-source:${label}] snapshot ===`);
    console.error(`ctx:\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mpv OSC loading source contracts", () => {
  it("@bugfix @regression-proof tog4in1 is loaded unconditionally without an env var gate", () => {
    console.info(`[mpv-osc-loading-source:read] reading packages/mpv/src/external.ts`);
    const source = readSource("../../../packages/mpv/src/external.ts");
    const hasEnvGate = source.includes("SF_MPV_ENABLE_TOG4IN1");
    const resolvesScript = source.includes("resolveMpvTog4in1Script()");
    console.info(
      `[mpv-osc-loading-source:read] sourceLength=${source.length} hasEnvGate=${hasEnvGate} resolvesScript=${resolvesScript}`
    );
    if (hasEnvGate || !resolvesScript) {
      dumpMpvOscSnapshot("unconditional-load", {
        sourceLength: source.length,
        hasEnvGate,
        resolvesScript,
      });
    }

    // Must NOT have a conditional gate like SF_MPV_ENABLE_TOG4IN1
    expect(source).not.toContain("SF_MPV_ENABLE_TOG4IN1");

    // Must always resolve the tog4in1 script
    expect(source).toContain("resolveMpvTog4in1Script()");
  });

  it("@bugfix @regression-proof tog4in1 script file exists at resolved path", () => {
    const scriptPath = resolveMpvTog4in1Script();
    const exists = scriptPath ? existsSync(scriptPath as string) : false;
    console.info(`[mpv-osc-loading-source:script-path] scriptPath=${String(scriptPath)} exists=${exists}`);
    if (!scriptPath || !exists) {
      dumpMpvOscSnapshot("script-path", { scriptPath, exists });
    }
    expect(scriptPath).toBeTruthy();
    expect(existsSync(scriptPath as string)).toBe(true);
  });

  it("@bugfix @regression-proof tog4in1 fonts directory exists at resolved path", () => {
    const fontsDir = resolveMpvTog4in1FontsDir();
    const exists = fontsDir ? existsSync(fontsDir as string) : false;
    console.info(`[mpv-osc-loading-source:fonts-dir] fontsDir=${String(fontsDir)} exists=${exists}`);
    if (!fontsDir || !exists) {
      dumpMpvOscSnapshot("fonts-dir", { fontsDir, exists });
    }
    expect(fontsDir).toBeTruthy();
    expect(existsSync(fontsDir as string)).toBe(true);
  });

  it("@bugfix @regression-proof buildExternalMpvArgs includes tog4in1 and fonts", () => {
    const args = buildExternalMpvArgs({
      url: "http://localhost/test.m3u8",
    });
    const hasTog4in1 = args.some((arg) => arg.includes("tog4in1.lua"));
    const hasFontsDir = args.some((arg) => arg.startsWith("--osd-fonts-dir="));
    console.info(
      `[mpv-osc-loading-source:build-args] argc=${args.length} hasTog4in1=${hasTog4in1} hasFontsDir=${hasFontsDir}`
    );
    if (!hasTog4in1 || !hasFontsDir) {
      dumpMpvOscSnapshot("build-args", { args, hasTog4in1, hasFontsDir });
    }
    expect(hasTog4in1).toBe(true);
    expect(hasFontsDir).toBe(true);
  });
});
