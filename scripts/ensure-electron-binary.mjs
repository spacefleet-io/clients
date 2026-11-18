// Fetch the Electron binary for an app workspace before electron-vite starts.
//
// Since Electron 42 the `electron` package has no postinstall: the binary is
// only downloaded on the first `require("electron")`. electron-vite never
// requires it; it reads `path.txt` itself and fails with
// "Error: Electron uninstall" after a fresh `bun install`. The dev launchers
// call this first so `turbo run dev` works on a clean checkout.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const ensureElectronBinary = (appDir) => {
  const require = createRequire(path.join(appDir, "package.json"));
  const pkgDir = path.dirname(require.resolve("electron/package.json"));
  const pathFile = path.join(pkgDir, "path.txt");
  if (existsSync(pathFile)) {
    const binary = readFileSync(pathFile, "utf8").trim();
    if (binary && existsSync(path.join(pkgDir, "dist", binary))) return;
  }
  console.log(`[dev] Electron binary missing in ${pkgDir}, downloading it once...`);
  const result = spawnSync(process.execPath, [path.join(pkgDir, "install.js")], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `Electron binary download failed (exit ${result.status ?? result.signal}). Run "bunx --no-install install-electron" from ${appDir} and retry.`,
    );
  }
};
