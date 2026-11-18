import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/conformance-cli.ts", import.meta.url));
const HELPER = fileURLToPath(new URL("../src/helper-platform.ts", import.meta.url));

const run = (...args: string[]) => spawnSync("bun", [CLI, "--only", "identity", "--json", ...args], { encoding: "utf8" });
/** A check that needs the helper module (it imports the platform in a child process). */
const runWithHelper = (...args: string[]) => spawnSync("bun", [CLI, "--only", "process-graceful-stop", "--json", ...args], { encoding: "utf8" });

describe("conformance-cli --expect-ok", () => {
  it("exits non-zero when fewer checks are ok than expected, even though none failed (a skipped or unselected check is not a pass)", () => {
    const r = run("--expect-ok", "19");
    console.info(`[conformance-cli.test] exit ${r.status}, stderr tail: ${r.stderr.slice(-200)}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1 of 19 expected checks ok/);
    expect(JSON.parse(r.stdout).results).toHaveLength(1);
  });

  it("exits zero when the expected number of checks is ok", () => {
    expect(run("--expect-ok", "1").status).toBe(0);
    expect(run().status).toBe(0);
  });

  it("refuses a non-numeric --expect-ok", () => {
    const r = run("--expect-ok", "many");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--expect-ok/);
  });
});

describe("conformance-cli --helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-conformance-helper-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads the helper platform module from the given path (a bundled CLI has no sibling helper-platform.ts)", () => {
    const elsewhere = join(dir, "helper.ts");
    writeFileSync(elsewhere, `export { platform } from ${JSON.stringify(HELPER)};\n`);
    const r = runWithHelper("--helper", elsewhere);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).results[0]).toMatchObject({ id: "process-graceful-stop", status: "ok" });
  });
});
