/**
 * @bugfix @regression-proof
 * Since Electron 42 the `electron` package has no postinstall: the binary is
 * fetched lazily on the first `require("electron")`. electron-vite 5 never
 * requires it; it reads `path.txt` directly and fails with
 * "Error: Electron uninstall" on a fresh `bun install`, so `bun run dev`
 * (turbo run dev --filter=@space/badger-desktop) could not start.
 * The dev launchers must fetch the binary before spawning electron-vite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureElectronBinary } from "../../../../scripts/ensure-electron-binary.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fake app workspace whose node_modules/electron mimics the real package layout. */
const makeApp = (opts: { installed: boolean; installExit?: number }) => {
  const app = mkdtempSync(path.join(tmpdir(), "sf-ensure-electron-"));
  dirs.push(app);
  const pkg = path.join(app, "node_modules", "electron");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "fake-app" }));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "electron", version: "44.7.0", main: "index.js" }));
  writeFileSync(path.join(pkg, "index.js"), "module.exports = 'unused';\n");
  // install.js records each run, then lays out path.txt + dist/<binary> like @electron/get does.
  writeFileSync(
    path.join(pkg, "install.js"),
    [
      "const fs = require('fs'); const p = require('path');",
      "fs.appendFileSync(p.join(__dirname, 'runs.log'), 'run\\n');",
      `if (${opts.installExit ?? 0} !== 0) process.exit(${opts.installExit ?? 0});`,
      "fs.mkdirSync(p.join(__dirname, 'dist'), { recursive: true });",
      "fs.writeFileSync(p.join(__dirname, 'dist', 'electron'), '');",
      "fs.writeFileSync(p.join(__dirname, 'path.txt'), 'electron');",
    ].join("\n"),
  );
  if (opts.installed) {
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "dist", "electron"), "");
    writeFileSync(path.join(pkg, "path.txt"), "electron");
  }
  const runs = () => (existsSync(path.join(pkg, "runs.log")) ? readFileSync(path.join(pkg, "runs.log"), "utf8").split("\n").filter(Boolean).length : 0);
  return { app, pkg, runs };
};

describe("ensureElectronBinary (dev launchers)", () => {
  it("downloads the binary when path.txt is missing (fresh bun install)", () => {
    const { app, pkg, runs } = makeApp({ installed: false });
    ensureElectronBinary(app);
    expect(runs()).toBe(1);
    expect(readFileSync(path.join(pkg, "path.txt"), "utf8")).toBe("electron");
  });

  it("re-downloads when path.txt exists but the dist binary is gone", () => {
    const { app, pkg, runs } = makeApp({ installed: true });
    rmSync(path.join(pkg, "dist"), { recursive: true });
    ensureElectronBinary(app);
    expect(runs()).toBe(1);
    expect(existsSync(path.join(pkg, "dist", "electron"))).toBe(true);
  });

  it("does nothing when the binary is already installed", () => {
    const { app, runs } = makeApp({ installed: true });
    ensureElectronBinary(app);
    expect(runs()).toBe(0);
  });

  it("throws with the manual command when the download fails", () => {
    const { app } = makeApp({ installed: false, installExit: 3 });
    expect(() => ensureElectronBinary(app)).toThrow(/install-electron/);
  });
});
