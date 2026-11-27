/**
 * @test-id PARROT-DESKTOP-IMPORT-QUEUE-001
 * @level unit (main's choice of what an asked scan starts and what waits behind the import under way)
 * @why UX-ADD-01 [@bugfix][@regression-proof]: on KDE Plasma Wayland, files dropped on Parrot while an import was
 *   scanning, uploading or waiting in its review showed a forbidden cursor and the drop did nothing (the window stood
 *   aside, log 2026-11-26 20:23-20:24). A drop or a "+" pick during an import now waits behind it and is scanned once
 *   the import is over.
 */
import { describe, expect, it } from "vitest";
import { nextImportSources } from "../src/main/importJobs";
import type { ParrotImportStatus } from "../src/shared/ipc";

const SUITE = "[parrot-import-queue]";
const at = (running: boolean, phase: ParrotImportStatus["phase"]) => ({ running, phase });

// @req UX-ADD-01[parrot] @req PAR-UP-05
describe("what an asked scan starts [@bugfix][@regression-proof]", () => {
  it.each([
    ["scanning", at(true, "scanning")],
    ["uploading", at(true, "uploading")],
    ["in its review", at(false, "review")],
  ] as const)("keeps the sources waiting while the import is %s", (_label, status) => {
    const next = nextImportSources(status, ["/music/a"], ["/music/b", "/music/a"]);
    console.info(`${SUITE} ${status.phase}:`, next);
    expect(next).toEqual({ start: null, queued: ["/music/a", "/music/b"] });
  });

  it.each([
    ["done", at(false, "done")],
    ["idle", at(false, "idle")],
    ["cancelled", at(false, "cancelled")],
    ["failed", at(false, "failed")],
  ] as const)("starts the waiting sources and the dropped ones, once each, when the import is %s", (_label, status) => {
    const next = nextImportSources(status, ["/music/a", "/music/b"], ["/music/b", "/music/c"]);
    console.info(`${SUITE} ${status.phase}:`, next);
    expect(next).toEqual({ start: ["/music/a", "/music/b", "/music/c"], queued: [] });
  });

  it("starts nothing when nothing waits and nothing was dropped", () => {
    const next = nextImportSources(at(false, "done"), [], []);
    console.info(`${SUITE} empty:`, next);
    expect(next).toEqual({ start: null, queued: [] });
  });
});
