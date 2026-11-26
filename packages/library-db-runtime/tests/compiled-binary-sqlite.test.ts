import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Suite-id: compiled-binary-sqlite — kebab-case match for filename.
const TAG = "[compiled-binary-sqlite]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const tmp = mkdtempSync(join(tmpdir(), "sf-compiled-sqlite-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// `bun build --compile` writes a full bun binary (~100 MB): about 0.7-2.7 s on an idle runner, 6.6 s with the unit
// job's 4 suites in parallel, where bun's 5 s default killed the build mid-way (exit code null). CPU and disk work
// with nothing to wait on, so each test gets a 60 s budget instead of the default.
const COMPILE_TEST_TIMEOUT_MS = 60_000;

// Run the binaries from tmp: from the repo, cwd-relative node_modules resolution would mask the failure.
const compile = (entry: string, outName: string): string => {
  const outfile = join(tmp, outName);
  const started = performance.now();
  const build = Bun.spawnSync(["bun", "build", "--compile", "--outfile", outfile, join(import.meta.dir, "fixtures", entry)]);
  log("compiled", { entry, exitCode: build.exitCode, signal: build.signalCode, ms: Math.round(performance.now() - started) });
  if (build.exitCode !== 0) log("build stderr", build.stderr.toString());
  expect(build.exitCode).toBe(0);
  return outfile;
};

describe("library db inside a bun --compile binary", () => {
  // @bugfix @regression-proof — the packaged runtime (`bun build --compile`) answered every
  // sf-library-db-open with "Cannot find module 'better-sqlite3'": `drizzle-orm/bun-sqlite` was never bundled
  // (only reachable through createRequire), so the bun:sqlite path threw and fell back to better-sqlite3.
  it("opens a database once the entry registers the bun:sqlite modules", () => {
    const run = Bun.spawnSync([compile("compiled-sqlite-entry.ts", "registered")], { cwd: tmp });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toBe("sqlite-ok");
    expect(run.exitCode).toBe(0);
  }, COMPILE_TEST_TIMEOUT_MS);

  it("cannot open one without the registration (what the packaged runtime did)", () => {
    const run = Bun.spawnSync([compile("compiled-sqlite-entry-bare.ts", "bare")], { cwd: tmp });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("better-sqlite3");
  }, COMPILE_TEST_TIMEOUT_MS);
});
