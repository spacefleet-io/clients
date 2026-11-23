/**
 * @test-id RUNTIME-SPAWN-ENV-TRANSCODE-DIR-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why Ultimate stress finding F7 (issue #25, violation `transcode-dir-changed`):
 *      `SF_TRANSCODE_DIR` was defaulted to `<userData>/transcode` only inside
 *      window creation, which runs AFTER the first `RuntimeGuardian.start()`.
 *      Neither the guardian's spawn command env nor process.env had it when the
 *      first runtime spawned, so that runtime fell back to `<cwd>/.runtime/transcode` while every restarted
 *      runtime used `<userData>/transcode`. `job_state.json` (crash-resume
 *      state) then lived in a different dir than the one the respawned runtime
 *      searched, so a crash-resume redid finished work.
 *      Pre-fix `src/main/runtimeSpawnEnv.ts` does not exist and index.ts sets
 *      the variable in the window-creation path.
 * @covers apps/badger/desktop/src/main/runtimeSpawnEnv.ts
 *         apps/badger/desktop/src/main/index.ts (startup order)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyUserDataDirDefaults, buildRuntimeSpawnEnv } from "../src/main/runtimeSpawnEnv";

const USER_DATA = "/home/test/.config/@sf/desktop";
const indexSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");

const dump = (label: string, value: unknown) => {
  try {
    console.error(`=== [runtime-spawn-env:${label}] snapshot ===`);
    console.error(JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] runtime spawn env carries the userData transcode dir from the FIRST spawn", () => {
  it("defaults SF_TRANSCODE_DIR to <userData>/transcode in the spawn env and in process.env (single source)", () => {
    const processEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const spawnEnv = buildRuntimeSpawnEnv(processEnv, USER_DATA, undefined);
    console.info(`[runtime-spawn-env:default] spawn=${spawnEnv.SF_TRANSCODE_DIR} process=${processEnv.SF_TRANSCODE_DIR}`);
    try {
      expect(spawnEnv.SF_TRANSCODE_DIR).toBe(join(USER_DATA, "transcode"));
      expect(processEnv.SF_TRANSCODE_DIR).toBe(spawnEnv.SF_TRANSCODE_DIR);
      expect(spawnEnv.SF_BADGER_OFFLINE_DIR).toBe(join(USER_DATA, "offline"));
      expect(spawnEnv.SF_USER_DATA_PATH).toBe(USER_DATA);
    } catch (err) {
      dump("default", { spawnEnv, processEnv });
      throw err;
    }
  });

  it("two spawn envs (first spawn + respawn) agree on the transcode dir", () => {
    const processEnv: NodeJS.ProcessEnv = {};
    const first = buildRuntimeSpawnEnv(processEnv, USER_DATA, "3020");
    const respawn = buildRuntimeSpawnEnv(processEnv, USER_DATA, "3020");
    expect(first.SF_TRANSCODE_DIR).toBe(respawn.SF_TRANSCODE_DIR);
    expect(first.SF_TRANSCODE_DIR).toBe(join(USER_DATA, "transcode"));
  });

  it("keeps an explicit SF_TRANSCODE_DIR / SF_BADGER_OFFLINE_DIR override", () => {
    const processEnv: NodeJS.ProcessEnv = { SF_TRANSCODE_DIR: "/mnt/fast/transcode", SF_BADGER_OFFLINE_DIR: "/mnt/fast/offline" };
    const result = applyUserDataDirDefaults(processEnv, USER_DATA);
    console.info(`[runtime-spawn-env:override] ${JSON.stringify(result)}`);
    expect(processEnv.SF_TRANSCODE_DIR).toBe("/mnt/fast/transcode");
    expect(processEnv.SF_BADGER_OFFLINE_DIR).toBe("/mnt/fast/offline");
    expect(result.transcodeDirSource).toBe("env");
    expect(result.offlineDirSource).toBe("env");
  });

  it("treats an empty SF_TRANSCODE_DIR as unset (unchanged semantics)", () => {
    const processEnv: NodeJS.ProcessEnv = { SF_TRANSCODE_DIR: "" };
    applyUserDataDirDefaults(processEnv, USER_DATA);
    expect(processEnv.SF_TRANSCODE_DIR).toBe(join(USER_DATA, "transcode"));
  });

  it("forwards the derived PORT and drops undefined env values", () => {
    const spawnEnv = buildRuntimeSpawnEnv({ KEEP: "1", DROP: undefined }, USER_DATA, "46659");
    expect(spawnEnv.PORT).toBe("46659");
    expect(spawnEnv.KEEP).toBe("1");
    expect("DROP" in spawnEnv).toBe(false);
  });
});

describe("[@bugfix][@regression-proof] desktop main resolves the transcode dir BEFORE the guardian exists", () => {
  it("builds the spawn env via buildRuntimeSpawnEnv before `new RuntimeGuardian(`", () => {
    const builderIdx = indexSource.indexOf("buildRuntimeSpawnEnv(process.env");
    const guardianIdx = indexSource.indexOf("new RuntimeGuardian(");
    console.info(`[runtime-spawn-env:order] builderIdx=${builderIdx} guardianIdx=${guardianIdx}`);
    try {
      expect(builderIdx).toBeGreaterThan(-1);
      expect(guardianIdx).toBeGreaterThan(-1);
      expect(builderIdx).toBeLessThan(guardianIdx);
    } catch (err) {
      dump("order", { builderIdx, guardianIdx });
      throw err;
    }
  });

  it("does not assign SF_TRANSCODE_DIR / SF_BADGER_OFFLINE_DIR anywhere in index.ts (window creation is too late)", () => {
    const assignments = indexSource
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /process\.env\.SF_(TRANSCODE_DIR|BADGER_OFFLINE_DIR)\s*=[^=]/.test(text));
    console.info(`[runtime-spawn-env:no-late-assign] assignments=${JSON.stringify(assignments)}`);
    expect(assignments).toEqual([]);
  });
});
