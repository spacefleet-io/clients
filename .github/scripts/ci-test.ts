#!/usr/bin/env bun
// Runs the unit tests of this repository in CI, minus the known failures in .github/known-failing-tests.txt.
//
//   bun .github/scripts/ci-test.ts
//
// Every listed file also fails upstream, in SpaceFleet's repository where this code is developed: the list
// keeps CI green and says so honestly instead of hiding the failure. A fix there removes the line. CI only:
// it deletes the listed files from the checkout before the run. A line naming a workspace directory (ending
// in "/") skips that workspace's whole test run: for a suite whose failing cases change from run to run.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
export const KNOWN_FAILING_LIST = ".github/known-failing-tests.txt";
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const UPSTREAM_TOO = "fails upstream too";

export type KnownFailure = { path: string; reason: string };

/** Parses the list: `<test file or workspace dir/><TAB><reason>` per line, `#` comments and blank lines ignored. */
export const parseKnownFailures = (text: string): KnownFailure[] =>
  text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "" && !line.startsWith("#"))
    .map(({ line, number }) => {
      const [path, reason, ...rest] = line.split("\t");
      if (!path || !reason || rest.length > 0) throw new Error(`${KNOWN_FAILING_LIST}:${number}: expected <test file><TAB><reason>`);
      if (!TEST_FILE.test(path) && !path.endsWith("/")) throw new Error(`${KNOWN_FAILING_LIST}:${number}: ${path} is neither a test file nor a workspace dir/`);
      if (!reason.endsWith(UPSTREAM_TOO)) throw new Error(`${KNOWN_FAILING_LIST}:${number}: the reason must end with "${UPSTREAM_TOO}"`);
      return { path, reason };
    });

const packageName = (dir: string): string => (JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { name: string }).name;

const hasTestFile = (dir: string): boolean =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? entry.name !== "node_modules" && hasTestFile(join(dir, entry.name)) : TEST_FILE.test(entry.name),
  );

if (import.meta.main) {
  if (process.env.CI !== "true") throw new Error("ci-test.ts deletes the listed test files: run it in a CI checkout only (CI=true)");
  const known = parseKnownFailures(readFileSync(join(ROOT, KNOWN_FAILING_LIST), "utf8"));
  const workspaces = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] }).workspaces;
  const skippedWorkspaces = new Set<string>();
  for (const { path, reason } of known) {
    if (path.endsWith("/")) {
      const dir = path.slice(0, -1);
      if (!workspaces.includes(dir)) throw new Error(`${KNOWN_FAILING_LIST}: ${path} is no longer a workspace; remove its line`);
      skippedWorkspaces.add(dir);
      console.log(`[ci-test] skipped ${packageName(dir)} (${dir}): ${reason}`);
      continue;
    }
    if (!existsSync(join(ROOT, path))) throw new Error(`${KNOWN_FAILING_LIST}: ${path} no longer exists; remove its line`);
    rmSync(join(ROOT, path));
    console.log(`[ci-test] skipped ${path}: ${reason}`);
  }
  // A workspace with no test file left (all listed here, or left out of this repository) has nothing to run;
  // its runner would fail on "no test files found".
  for (const dir of workspaces) {
    if (skippedWorkspaces.has(dir) || hasTestFile(join(ROOT, dir))) continue;
    const scripts = (JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts;
    if (!scripts?.test) continue;
    console.log(`[ci-test] ${packageName(dir)} (${dir}) has no test left to run`);
    skippedWorkspaces.add(dir);
  }
  const filters = [...skippedWorkspaces].map((dir) => `--filter=!${packageName(dir)}`);
  // Two workspaces at a time: several suites time out at their 5 s limit on a busy runner. --continue runs every
  // workspace even after one fails, so a run reports all failures at once (the exit code still fails).
  const run = Bun.spawnSync(["bun", "run", "test", "--concurrency=2", "--continue", ...filters], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  process.exit(run.exitCode ?? 1);
}
