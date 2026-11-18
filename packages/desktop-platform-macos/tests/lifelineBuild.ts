import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LIFELINE_SOURCE = fileURLToPath(new URL("../native/sf-lifeline.c", import.meta.url));

/**
 * Compile native/sf-lifeline.c into a fresh temp dir with the flags media-deps uses, so the package
 * tests prove the source in this checkout and do not depend on a fetched deps bundle.
 */
export const buildLifeline = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sf-lifeline-"));
  const out = join(dir, "sf-lifeline");
  const res = spawnSync("clang", ["-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0", "-o", out, LIFELINE_SOURCE], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`clang failed (${res.status ?? res.error?.message}):\n${res.stderr}`);
  console.info(`[sf-lifeline] built ${out}`);
  return out;
};
