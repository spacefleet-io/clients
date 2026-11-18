import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PACKAGE_TARGETS, runtimeBinaryName, runtimeCompileArgs } from "../scripts/package-targets.mjs";

const T = "[runtime-compile-node-env]";

// The real bun, not node_modules/.bin/bun: desktop devDepends on the npm `bun` package, whose shim is a stub until its
// postinstall runs (CI installs with --ignore-scripts), and the test runner puts that .bin first on PATH (same lookup as
// harness-service-reaper.test.ts).
const bunName = process.platform === "win32" ? "bun.exe" : "bun";
const bun =
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !dir.includes("node_modules"))
    .map((dir) => join(dir, bunName))
    .find((candidate) => existsSync(candidate)) ?? join(homedir(), ".bun", "bin", bunName);
// The compiled probe must run on this host, so the target is the host's OS (bun cross-compiles, a foreign binary can't run).
// Only linux/win32 x64 hosts have a PACKAGE_TARGET; the describe below skips everywhere else (platform-only skipIf, as
// tests/tools/ci_media_binaries.test.ts requires of a skip that is not a media-binary gate).
const hostTarget = Object.values(PACKAGE_TARGETS).find((target) => target.nodePlatform === process.platform && process.arch === "x64");
if (!hostTarget) console.info(`${T} skipping the compiled-probe tests: no PACKAGE_TARGET runs on ${process.platform}/${process.arch}`);

// The probe reads NODE_ENV the way the shared logger (packages/logger: `process.env.NODE_ENV ?? "development"`) and
// the jobs engine (`process.env.NODE_ENV !== "production"`) do.
const PROBE = [
  'console.log(JSON.stringify({ env: process.env.NODE_ENV ?? "development", validates: process.env.NODE_ENV !== "production" }));',
  "",
].join("\n");

const runProbe = (binary: string, nodeEnv: string | undefined) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const result = spawnSync(binary, [], { env, encoding: "utf8" });
  console.info(`${T} run NODE_ENV=${JSON.stringify(nodeEnv)} status=${result.status} stdout=${result.stdout?.trim()} stderr=${result.stderr?.trim()}`);
  expect(result.status, `probe exited ${result.status}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as { env: string; validates: boolean };
};

// @bugfix @regression-proof: `bun build --compile` inlines `process.env.NODE_ENV` as "development" at build time, so the
// installed runtime logged env=development (2871 + 413 lines in Windows run 14649) whatever NODE_ENV its spawn env held
// (PR #294 only set the variable, which an inlined read never sees).
describe.skipIf(process.platform + process.arch !== "linuxx64" && process.platform + process.arch !== "win32x64")("packaged runtime binary is production whatever env it is spawned with", () => {
  let dir = "";
  let binary = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-runtime-node-env-"));
    const entry = join(dir, "probe.ts");
    writeFileSync(entry, PROBE);
    binary = join(dir, runtimeBinaryName(hostTarget!));
    const args = runtimeCompileArgs(hostTarget!, binary, entry);
    console.info(`${T} compile: ${bun} ${args.join(" ")}`);
    const compiled = spawnSync(bun, args, { cwd: dir, encoding: "utf8" });
    console.info(`${T} compile status=${compiled.status} stdout=${compiled.stdout?.trim()} stderr=${compiled.stderr?.trim()}`);
    expect(compiled.status, `bun build --compile failed: ${compiled.stderr}`).toBe(0);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads production with NODE_ENV unset (a real packaged launch)", () => {
    expect(runProbe(binary, undefined)).toEqual({ env: "production", validates: false });
  });

  it("reads production when the spawn env says test (the e2e harness) or development", () => {
    expect(runProbe(binary, "test")).toEqual({ env: "production", validates: false });
    expect(runProbe(binary, "development")).toEqual({ env: "production", validates: false });
  });
});

describe("runtimeCompileArgs", () => {
  it("compiles the real runtime entry and keeps the Windows console hidden", () => {
    const windows = runtimeCompileArgs(PACKAGE_TARGETS["windows-x64"]!, "out/runtime.exe");
    expect(windows).toEqual(expect.arrayContaining(["--windows-hide-console", "--target=bun-windows-x64"]));
    expect(windows.slice(-3)).toEqual(["--outfile", "out/runtime.exe", "src/index.ts"]);
    expect(windows).toEqual(expect.arrayContaining(["--define", 'process.env.NODE_ENV="production"']));
    expect(runtimeCompileArgs(PACKAGE_TARGETS["linux-x64"]!, "out/runtime")).not.toContain("--windows-hide-console");
  });
});
