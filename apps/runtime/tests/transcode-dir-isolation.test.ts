/**
 * @test-id RUNTIME-TEST-TRANSCODE-DIR-001
 * @level unit
 * @why A Badger commit saves its pending seek-bar preview run beside the job dir (MPV-PREV-02); a test that commits
 *      without its own `SF_TRANSCODE_DIR` used to leave those files in the git-ignored
 *      `apps/runtime/.runtime/transcode`, where the next suite's start-up resume picked them up. Every test now
 *      gets a throwaway transcode dir (tests/setup/transcodeDir.ts), even after an earlier test removed it.
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const SUITE = "transcode-dir-isolation";

describe("each test gets a throwaway transcode dir", () => {
  it("@req MPV-PREV-02 SF_TRANSCODE_DIR points into the system temp dir", () => {
    const dir = process.env.SF_TRANSCODE_DIR;
    console.info(`[${SUITE}:first] SF_TRANSCODE_DIR=${dir}`);
    expect(dir?.startsWith(tmpdir())).toBe(true);
    // What several suites do in afterEach.
    delete process.env.SF_TRANSCODE_DIR;
  });

  it("@req MPV-PREV-02 it is back for the next test after a test removed it", () => {
    const dir = process.env.SF_TRANSCODE_DIR;
    console.info(`[${SUITE}:second] SF_TRANSCODE_DIR=${dir}`);
    expect(dir?.startsWith(tmpdir())).toBe(true);
  });
});
