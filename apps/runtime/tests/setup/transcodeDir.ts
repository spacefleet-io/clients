/**
 * Every test gets a throwaway Badger transcode dir (`SF_TRANSCODE_DIR`), so job dirs and pending seek-bar preview
 * runs (MPV-PREV-02) never land in the git-ignored `apps/runtime/.runtime/transcode` and leak into later suites.
 * Re-applied before each test because several suites delete the variable in their afterEach; a suite that sets its
 * own dir in beforeEach still wins (it runs after this hook).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const transcodeDir = mkdtempSync(join(tmpdir(), "sf-runtime-transcode-"));

beforeEach(() => {
  if (!process.env.SF_TRANSCODE_DIR?.trim()) process.env.SF_TRANSCODE_DIR = transcodeDir;
});

afterAll(() => {
  rmSync(transcodeDir, { recursive: true, force: true });
});
