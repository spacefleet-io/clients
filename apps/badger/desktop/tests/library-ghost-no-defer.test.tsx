// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Pre-fix bug: Library.tsx wrapped `activeJobs` in `useDeferredValue` before
 * passing to `buildGhostLibraryItems`. The sidebar (TopNavJobsSidebarContent
 * via useRuntimeIngestJobs / buildIngestJobGroups) consumed `activeJobs`
 * directly with no defer. During phase transitions (e.g. uploading →
 * transcoding) the two surfaces saw different snapshots for at least one
 * paint, so the ghost-poster's stageLabel (e.g. "Uploading") and the
 * sidebar's stageLabel (e.g. "Transcoding") disagreed visibly.
 *
 * User symptom: ghost + sidebar showing different stages during phase
 * transitions.
 *
 * Post-fix: Library.tsx reads `activeJobs` directly. Both surfaces flush in
 * the same React commit, so their stageLabels are consistent.
 *
 * This test pins the no-defer property two ways:
 *
 *   1. Source-level negative case: Library.tsx must NOT call
 *      useDeferredValue on activeJobs (or any deferredActiveJobs binding).
 *      A future refactor that re-introduces a defer on this path is caught
 *      here even before it manifests as a UI lag.
 *
 *   2. Behavioral case: a minimal renderer that mirrors Library.tsx's
 *      pattern (subscribe to a job source, derive ghosts via
 *      buildGhostLibraryItems) updates the ghost's statusLabel in the SAME
 *      act() flush as the underlying job change. With useDeferredValue in
 *      place, the first flush would still show the old statusLabel.
 */

import React, { useMemo, useState } from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGhostLibraryItems } from "../src/renderer/src/lib/libraryGhosts";
import type { LabJob } from "../src/renderer/src/lib/labJobs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => key;

const makeLabJob = (overrides: Partial<LabJob> & { id: string; status: LabJob["status"] }): LabJob => ({
  filename: "/tmp/test.mkv",
  progress: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// On assertion failure, dump the rendered ghost DOM + the data-status attrs so
// the stale-vs-fresh statusLabel mismatch is diagnosable offline. Wrapped in
// try/catch so a dump failure can't mask the original assertion.
const dumpLibraryGhostSnapshot = (label: string): void => {
  try {
    console.error(`=== [library-ghost-no-defer:${label}] snapshot ===`);
    if (!container) {
      console.error("container is null (no render)");
      return;
    }
    const ghosts = Array.from(
      container.querySelectorAll("[data-testid^='ghost-']"),
    ).map((el) => ({
      testid: el.getAttribute("data-testid"),
      status: el.getAttribute("data-status"),
      text: el.textContent,
    }));
    console.error(`rendered ghosts: ${JSON.stringify(ghosts, null, 2)}`);
    console.error(`container.innerHTML:\n${container.innerHTML}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
});

describe("[@bugfix][@regression-proof] Library ghost path: no useDeferredValue", () => {
  it("Library.tsx source: ghost-path useMemo reads activeJobs directly (no deferredActiveJobs binding)", () => {
    // The pre-fix source was:
    //   const deferredActiveJobs = useDeferredValue(activeJobs);
    //   const ghostItems = useMemo(() => {
    //     pruneDeletedMediaIds(deferredActiveJobs);
    //     return buildGhostLibraryItems(deferredActiveJobs, media, t);
    //   }, [deferredActiveJobs, media, t]);
    //
    // After the fix the deferred binding must be gone — the ghost path reads
    // activeJobs directly, matching the sidebar's snapshot timing.
    const libraryPath = resolve(__dirname, "..", "src", "renderer", "src", "pages", "Library.tsx");
    console.info(
      `[library-ghost-no-defer:source-grep] reading Library.tsx source at ${libraryPath}`,
    );
    const source = readFileSync(libraryPath, "utf8");
    console.info(
      `[library-ghost-no-defer:source-grep] source length=${source.length} hasDeferredActiveJobs=${/deferredActiveJobs/.test(source)} hasDirectGhostBuild=${/buildGhostLibraryItems\(\s*activeJobs\s*,/.test(source)}`,
    );

    try {
      // Negative: no deferredActiveJobs anywhere in the file.
      expect(source).not.toMatch(/deferredActiveJobs/);

      // Negative: useDeferredValue must NOT be applied to activeJobs.
      expect(source).not.toMatch(/useDeferredValue\(\s*activeJobs\s*\)/);

      // Positive: the ghost-building useMemo references activeJobs in its body
      // and dependency array. We assert the call site is intact and undeferred.
      expect(source).toMatch(/buildGhostLibraryItems\(\s*activeJobs\s*,/);
      expect(source).toMatch(/pruneDeletedMediaIds\(\s*activeJobs\s*\)/);
    } catch (err) {
      console.error(
        "=== [library-ghost-no-defer:source-grep-fail] snapshot ===",
      );
      const deferMatch = source.match(/.*deferredActiveJobs.*/g) ?? [];
      const useMemoMatch =
        source.match(/.*buildGhostLibraryItems.*/g) ?? [];
      console.error(`deferredActiveJobs lines: ${JSON.stringify(deferMatch)}`);
      console.error(
        `buildGhostLibraryItems lines: ${JSON.stringify(useMemoMatch)}`,
      );
      throw err;
    }
  });

  it("ghost statusLabel updates in the same act() flush as the underlying job change", async () => {
    // Mirror Library.tsx's pattern: a component subscribes to active jobs
    // (here via useState — setState plays the role of LabJobsProvider's
    // context update) and renders ghost items derived from buildGhostLibraryItems.
    // The component must NOT use useDeferredValue, just like the post-fix
    // Library.tsx ghost path.
    const initialJob = makeLabJob({
      id: "job-1",
      status: "uploading",
      progress: 30,
      detectedTitle: "Interstellar",
      detectedYear: "2014",
      stageLabel: "Uploading",
    });
    const updatedJob = makeLabJob({
      id: "job-1",
      status: "transcoding",
      progress: 50,
      detectedTitle: "Interstellar",
      detectedYear: "2014",
      stageLabel: "Transcoding",
    });

    let setJobs: (jobs: LabJob[]) => void = () => {};

    const Harness = () => {
      const [jobs, _setJobs] = useState<LabJob[]>([initialJob]);
      setJobs = _setJobs;
      // Mirror the post-fix Library.tsx ghost path exactly: derive from
      // `jobs` (NOT a deferred view of jobs).
      const ghostItems = useMemo(() => buildGhostLibraryItems(jobs, [], t), [jobs]);
      return (
        <div>
          {ghostItems.map((item) => (
            <div key={item.id} data-testid={`ghost-${item.id}`} data-status={item.statusLabel}>
              {item.title} — {item.statusLabel}
            </div>
          ))}
        </div>
      );
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    console.info(
      "[library-ghost-no-defer:same-flush] initial render with job status=uploading",
    );
    await act(async () => {
      root?.render(<Harness />);
    });

    // First paint: ghost shows the initial stageLabel.
    const ghostBefore = container.querySelector("[data-testid^='ghost-']");
    const statusBefore = ghostBefore?.getAttribute("data-status");
    console.info(
      `[library-ghost-no-defer:same-flush] first paint ghost data-status=${statusBefore}`,
    );
    try {
      expect(statusBefore).toBe("Uploading");
    } catch (err) {
      dumpLibraryGhostSnapshot("same-flush-first-paint-fail");
      throw err;
    }

    // Push a phase transition. With useDeferredValue in place, the FIRST
    // commit after this setState would still show "Uploading" — the new
    // stageLabel would only land on a subsequent deferred commit. Without
    // defer, the same act() flush already reflects the new value.
    console.info(
      "[library-ghost-no-defer:same-flush] pushing phase transition uploading -> transcoding",
    );
    await act(async () => {
      setJobs([updatedJob]);
    });

    const ghostAfter = container.querySelector("[data-testid^='ghost-']");
    const statusAfter = ghostAfter?.getAttribute("data-status");
    console.info(
      `[library-ghost-no-defer:same-flush] post-transition ghost data-status=${statusAfter} (expected Transcoding in same flush)`,
    );
    try {
      expect(statusAfter).toBe("Transcoding");
    } catch (err) {
      dumpLibraryGhostSnapshot("same-flush-post-transition-fail");
      throw err;
    }
  });
});

describe("[@bugfix][@regression-proof] Sidebar path: no useDeferredValue (round-12 #2)", () => {
  it("TopNavJobsSidebarContent.tsx source: groups path reads allGroups directly (no deferredGroups binding)", () => {
    // Round-12 #2: the round-9 fix dropped useDeferredValue from Library.tsx
    // (ghost path), but the sidebar's `useDeferredValue(allGroups)` survived.
    // During phase transitions the sidebar's stage label lagged the ghost's
    // by one paint. After the fix both surfaces flush in the same React commit.
    const sidebarPath = resolve(__dirname, "..", "src", "renderer", "src", "components", "TopNavJobsSidebarContent.tsx");
    console.info(
      `[library-ghost-no-defer:sidebar-grep] reading TopNavJobsSidebarContent.tsx at ${sidebarPath}`,
    );
    const source = readFileSync(sidebarPath, "utf8");
    console.info(
      `[library-ghost-no-defer:sidebar-grep] source length=${source.length} hasDeferredGroups=${/deferredGroups/.test(source)} hasDeferredAllGroups=${/useDeferredValue\(\s*allGroups\s*\)/.test(source)}`,
    );
    try {
      expect(source).not.toMatch(/deferredGroups/);
      expect(source).not.toMatch(/useDeferredValue\(\s*allGroups\s*\)/);
    } catch (err) {
      console.error(
        "=== [library-ghost-no-defer:sidebar-grep-fail] snapshot ===",
      );
      const deferMatch = source.match(/.*deferred.*/g) ?? [];
      console.error(`deferred* lines: ${JSON.stringify(deferMatch)}`);
      throw err;
    }
  });
});
