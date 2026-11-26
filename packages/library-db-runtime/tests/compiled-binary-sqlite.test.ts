import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Suite-id: compiled-binary-sqlite — kebab-case match for filename.
const tmp = mkdtempSync(join(tmpdir(), "sf-compiled-sqlite-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Run the binaries from tmp: from the repo, cwd-relative node_modules resolution would mask the failure.
const compile = (entry: string, outName: string): string => {
  const outfile = join(tmp, outName);
  const build = Bun.spawnSync(["bun", "build", "--compile", "--outfile", outfile, join(import.meta.dir, "fixtures", entry)]);
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
  });

  it("cannot open one without the registration (what the packaged runtime did)", () => {
    const run = Bun.spawnSync([compile("compiled-sqlite-entry-bare.ts", "bare")], { cwd: tmp });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("better-sqlite3");
  });
});
