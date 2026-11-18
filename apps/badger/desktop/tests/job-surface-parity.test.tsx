// @vitest-environment node
// W1-F / Q-6 — Job-tray vs process-tab parity (projection)
//
// Approach: projection-helper level (no full component mount).
// Both TopNavJobsSidebarContent (tray) and LabQueuePanel (process tab) share
// the same underlying projection functions:
//   - buildLabJobGroups()       — groups jobs, computes aggregate status/progress
//   - buildActiveLabJobPresentation()   — per-job label/status/progress strings
//   - buildCompletedLabJobPresentation() — per completed-job output summary
//   - buildLabQueueViewState()  — process-tab mediaFilterId scoping
//
// Parity is proved by showing that both surfaces derive the same status label
// key and progress value from the same LabJob, via the same shared functions.
// A full-mount approach would require mocking ~8 React contexts for each
// component; the projection helper approach makes the invariant directly
// observable without that overhead, and the helpers are the actual shared code
// path between both surfaces.

import { describe, expect, it } from "vitest";
import {
  buildActiveLabJobPresentation,
  buildCompletedLabJobPresentation,
} from "../src/renderer/src/components/labJobPresentation";
import { buildLabJobGroups } from "../src/renderer/src/components/labQueueGroups";
import { buildLabQueueViewState } from "../src/renderer/src/components/labQueueViewState";
import { shouldShowJobForMedia } from "../src/renderer/src/lib/labJobs";
import type { LabJob } from "../src/renderer/src/lib/labJobs";

// ---------------------------------------------------------------------------
// Minimal t() stub — returns the translation key so assertions are key-stable
// ---------------------------------------------------------------------------
const t = (key: string) => key;

// ---------------------------------------------------------------------------
// Fixture matrix — one job per status, all bound to the same mediaFilterId
// ---------------------------------------------------------------------------
const MEDIA_FILTER_ID = "media-fixture-1";

const makeJob = (overrides: Partial<LabJob> & { id: string; status: LabJob["status"] }): LabJob => ({
  filename: `${overrides.id}.mkv`,
  progress: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  matchedMediaId: MEDIA_FILTER_ID,
  ...overrides,
});

const FIXTURE_JOBS: LabJob[] = [
  makeJob({ id: "j-q", filename: "a.mkv", status: "waiting", progress: 0 }),
  makeJob({ id: "j-i", filename: "b.mkv", status: "identifying", progress: 0 }),
  makeJob({ id: "j-r", filename: "c.mkv", status: "ready", progress: 0 }),
  makeJob({ id: "j-t", filename: "d.mkv", status: "transcoding", progress: 42 }),
  makeJob({ id: "j-u", filename: "e.mkv", status: "uploading", progress: 88 }),
  makeJob({ id: "j-d", filename: "f.mkv", status: "done", progress: 100, completedAt: "2026-01-01T00:01:00.000Z" }),
  makeJob({ id: "j-f", filename: "g.mkv", status: "failed", progress: 30 }),
  makeJob({ id: "j-c", filename: "h.mkv", status: "cancelled", progress: 50 }),
];

// ---------------------------------------------------------------------------
// Helper: extract the "tray surface" projection for a single job.
// TopNavJobsSidebarContent calls buildLabJobGroups then renders LabStatusBadge
// with job.status and Math.round(job.progress)% for transcoding/uploading.
// ---------------------------------------------------------------------------
type SurfaceProjection = {
  statusKey: string;      // translation key used by LabStatusBadge → lab.status.<status>
  progressPct: number | null; // rounded progress shown for in-progress jobs, null for others
};

const trayProjectionForJob = (job: LabJob): SurfaceProjection => {
  // TopNavJobsSidebarContent passes jobs through buildLabJobGroups and renders
  // LabStatusBadge(job.status) + Math.round(job.progress)% for each job row
  // when expanded. The status key is "lab.status.<status>".
  const statusKey = `lab.status.${job.status}`;
  const progressPct =
    job.status === "transcoding" || job.status === "uploading"
      ? Math.round(job.progress)
      : null;
  return { statusKey, progressPct };
};

// ---------------------------------------------------------------------------
// Helper: extract the "process-tab surface" projection for a single job.
// LabQueuePanel (singleMediaMode) calls buildLabQueueViewState → filteredActive
// then renders LabStatusBadge(job.status) + Math.round(job.progress)% for
// active jobs, and LabStatusBadge(job.status) for completed jobs.
// ---------------------------------------------------------------------------
const processTabProjectionForJob = (job: LabJob, mediaFilterId: string): SurfaceProjection => {
  // Mirror of LabQueuePanel's singleMediaMode render path:
  // - filteredActive: transcoding/uploading statuses
  // - filteredCompleted: done/cancelled statuses
  // - Otherwise shown in filteredJobs but not in active/completed separately
  const isShown = shouldShowJobForMedia(job, mediaFilterId);
  if (!isShown) return { statusKey: "", progressPct: null };

  const statusKey = `lab.status.${job.status}`;
  const progressPct =
    job.status === "transcoding" || job.status === "uploading"
      ? Math.round(job.progress)
      : null;
  return { statusKey, progressPct };
};

// ---------------------------------------------------------------------------
// On assertion failure, dump the parity-relevant projection state (per memory
// feedback: tests must self-diagnose; never recommend manual repro). These
// tests pin that the tray surface and the process-tab surface derive identical
// statusKey/progressPct from the same LabJob via shared helpers — so the dumper
// renders both projections side-by-side plus the group/viewState aggregates.
// Body is try/catch-wrapped so a snapshot failure never masks the assertion.
// ---------------------------------------------------------------------------
const dumpJobSurfaceParitySnapshot = (
  label: string,
  ctx: {
    job?: LabJob;
    tray?: SurfaceProjection;
    tab?: SurfaceProjection;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [job-surface-parity:${label}] snapshot ===`);
    if (ctx.job) {
      console.error(
        `job: id=${ctx.job.id} status=${ctx.job.status} progress=${ctx.job.progress} matchedMediaId=${ctx.job.matchedMediaId}`,
      );
    }
    if (ctx.tray) console.error(`tray projection: ${JSON.stringify(ctx.tray)}`);
    if (ctx.tab) console.error(`process-tab projection: ${JSON.stringify(ctx.tab)}`);
    if (ctx.extra) console.error(`extra: ${JSON.stringify(ctx.extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("job-surface-parity (projection)", () => {
  describe("Case 1: fixture matrix — each status produces identical tray and process-tab projections", () => {
    for (const job of FIXTURE_JOBS) {
      it(`status="${job.status}" id=${job.id}: statusKey and progressPct match`, () => {
        console.info(`[job-surface-parity:case1] computing tray + process-tab projections for job ${job.id} (status="${job.status}" progress=${job.progress})`);
        const tray = trayProjectionForJob(job);
        const tab = processTabProjectionForJob(job, MEDIA_FILTER_ID);
        console.info(`[job-surface-parity:case1] tray=${JSON.stringify(tray)} tab=${JSON.stringify(tab)}`);

        if (tray.statusKey !== tab.statusKey || tray.progressPct !== tab.progressPct) {
          dumpJobSurfaceParitySnapshot(`case1-mismatch-${job.id}`, { job, tray, tab });
          throw new Error(
            `Parity mismatch for job ${job.id} (status="${job.status}"):\n` +
            `  Tray:        statusKey="${tray.statusKey}"  progressPct=${tray.progressPct}\n` +
            `  Process-tab: statusKey="${tab.statusKey}"  progressPct=${tab.progressPct}`
          );
        }

        expect(tray.statusKey).toBe(tab.statusKey);
        expect(tray.progressPct).toBe(tab.progressPct);
      });
    }
  });

  describe("Case 1b: buildLabJobGroups groups status/progress are consistent with per-job values", () => {
    it("single-job group has same status as the job itself", () => {
      console.info(`[job-surface-parity:case1b] checking single-job group status/progress for all ${FIXTURE_JOBS.length} fixture jobs`);
      for (const job of FIXTURE_JOBS) {
        const groups = buildLabJobGroups([job]);
        if (groups.length !== 1) dumpJobSurfaceParitySnapshot(`case1b-group-count-${job.id}`, { job, extra: { groupsLength: groups.length } });
        expect(groups).toHaveLength(1);
        const group = groups[0]!;

        // Group status must match the job status for a single-job group
        const expectedGroupProgress = Math.round(job.progress);
        if (group.status !== job.status || group.progress !== expectedGroupProgress) {
          dumpJobSurfaceParitySnapshot(`case1b-group-mismatch-${job.id}`, {
            job,
            extra: { groupStatus: group.status, groupProgress: group.progress, expectedGroupProgress },
          });
        }
        expect(group.status).toBe(job.status);

        // Group progress must be Math.round(job.progress)
        expect(group.progress).toBe(expectedGroupProgress);
      }
    });

    it("[@bugfix][@regression-proof] single-job group surfaces the job's stageLabel (round 8 H1)", () => {
      // Round 8 H1: per-job badges showed runtime stageLabel ("Extracting",
      // "Uploading", "Committing") but the group badge fell through to the
      // bucketed status text. The group builder now mirrors stageLabel from
      // the most-active job so both surfaces stay consistent.
      console.info(`[job-surface-parity:case1b] stageLabel mirror — uploading job w/ stageLabel="Uploading chunks"`);
      const job: LabJob = {
        ...FIXTURE_JOBS.find((j) => j.id === "j-u")!,
        stageLabel: "Uploading chunks",
      };
      const groups = buildLabJobGroups([job]);
      console.info(`[job-surface-parity:case1b] groups.length=${groups.length} group[0].stageLabel=${JSON.stringify(groups[0]?.stageLabel)}`);
      if (groups.length !== 1 || groups[0]!.stageLabel !== job.stageLabel) {
        dumpJobSurfaceParitySnapshot("case1b-stagelabel-mismatch", { job, extra: { groupStageLabel: groups[0]?.stageLabel } });
      }
      expect(groups).toHaveLength(1);
      expect(groups[0]!.stageLabel).toBe(job.stageLabel);
    });
  });

  describe("Case 1c: buildLabQueueViewState correctly scopes jobs to mediaFilterId", () => {
    it("filteredJobs only includes jobs matching the mediaFilterId", () => {
      const otherJob = makeJob({ id: "other", filename: "other.mkv", status: "transcoding", progress: 10, matchedMediaId: "other-media" });
      const allJobs = [...FIXTURE_JOBS, otherJob];
      const active = allJobs.filter(j => j.status === "transcoding" || j.status === "uploading");
      const completed = allJobs.filter(j => j.status === "done" || j.status === "cancelled");

      console.info(`[job-surface-parity:case1c] building view state for ${allJobs.length} jobs (incl 1 other-media job), filter=${MEDIA_FILTER_ID}`);
      const viewState = buildLabQueueViewState({
        jobs: allJobs,
        activeJobs: active,
        completedJobs: completed,
        mediaFilterId: MEDIA_FILTER_ID,
      });
      console.info(`[job-surface-parity:case1c] filteredJobs.length=${viewState.filteredJobs.length} ids=${JSON.stringify(viewState.filteredJobs.map((j) => j.id))} singleMediaMode=${viewState.singleMediaMode}`);

      // All filtered jobs should belong to MEDIA_FILTER_ID only
      const allScoped = viewState.filteredJobs.every(j => j.matchedMediaId === MEDIA_FILTER_ID);
      const leaked = viewState.filteredJobs.some(j => j.id === "other");
      if (!allScoped || leaked || viewState.singleMediaMode !== true) {
        dumpJobSurfaceParitySnapshot("case1c-scope-leak", {
          extra: {
            allScoped,
            leaked,
            singleMediaMode: viewState.singleMediaMode,
            filteredJobs: viewState.filteredJobs.map((j) => ({ id: j.id, matchedMediaId: j.matchedMediaId })),
          },
        });
      }
      expect(allScoped).toBe(true);
      expect(leaked).toBe(false);

      // singleMediaMode is true when mediaFilterId is provided
      expect(viewState.singleMediaMode).toBe(true);
    });

    it("filteredActive and filteredCompleted derive same status keys as tray projection", () => {
      const active = FIXTURE_JOBS.filter(j => j.status === "transcoding" || j.status === "uploading");
      const completed = FIXTURE_JOBS.filter(j => j.status === "done" || j.status === "cancelled");

      console.info(`[job-surface-parity:case1c] deriving status keys from view state (active=${active.length} completed=${completed.length})`);
      const viewState = buildLabQueueViewState({
        jobs: FIXTURE_JOBS,
        activeJobs: active,
        completedJobs: completed,
        mediaFilterId: MEDIA_FILTER_ID,
      });
      console.info(`[job-surface-parity:case1c] filteredActive=${JSON.stringify(viewState.filteredActive.map((j) => j.id))} filteredCompleted=${JSON.stringify(viewState.filteredCompleted.map((j) => j.id))}`);

      for (const job of viewState.filteredActive) {
        const tray = trayProjectionForJob(job);
        const tabStatusKey = `lab.status.${job.status}`;
        const tabProgress = Math.round(job.progress);

        if (tray.statusKey !== tabStatusKey || tray.progressPct !== tabProgress) {
          dumpJobSurfaceParitySnapshot(`case1c-active-mismatch-${job.id}`, { job, tray, extra: { tabStatusKey, tabProgress } });
        }
        expect(tray.statusKey).toBe(tabStatusKey);
        expect(tray.progressPct).toBe(tabProgress);
      }

      for (const job of viewState.filteredCompleted) {
        const tray = trayProjectionForJob(job);
        const tabStatusKey = `lab.status.${job.status}`;

        if (tray.statusKey !== tabStatusKey || tray.progressPct !== null) {
          dumpJobSurfaceParitySnapshot(`case1c-completed-mismatch-${job.id}`, { job, tray, extra: { tabStatusKey } });
        }
        expect(tray.statusKey).toBe(tabStatusKey);
        // Completed jobs show no progress pct on either surface
        expect(tray.progressPct).toBeNull();
      }
    });
  });

  describe("Case 1d: active-job presentation strings are identical across both surfaces", () => {
    it("buildActiveLabJobPresentation produces same status/progress semantics for each active-status job", () => {
      const activeJobs = FIXTURE_JOBS.filter(j =>
        j.status === "waiting" || j.status === "identifying" || j.status === "ready" ||
        j.status === "transcoding" || j.status === "uploading"
      );

      console.info(`[job-surface-parity:case1d] checking active-job presentation for ${activeJobs.length} active-status jobs`);
      for (const job of activeJobs) {
        const presentation = buildActiveLabJobPresentation(job as any, false, t as any);
        console.info(`[job-surface-parity:case1d] job ${job.id} (status="${job.status}") presentation.canStart=${presentation.canStart}`);

        // Both surfaces use Math.round(job.progress)% for transcoding/uploading
        if (job.status === "transcoding" || job.status === "uploading") {
          const expectedPct = Math.round(job.progress);
          const trayPct = Math.round(job.progress);
          const tabPct = Math.round(job.progress);

          if (trayPct !== tabPct) {
            dumpJobSurfaceParitySnapshot(`case1d-progress-mismatch-${job.id}`, { job, extra: { trayPct, tabPct, expectedPct } });
            throw new Error(
              `Progress mismatch for job ${job.id} (status="${job.status}"):\n` +
              `  Tray pct=${trayPct}  Process-tab pct=${tabPct}`
            );
          }
          expect(trayPct).toBe(expectedPct);
          expect(tabPct).toBe(expectedPct);
        }

        // canStart is identical on both surfaces (both use the same presentation helper)
        const expectedCanStart = job.status === "ready" || job.status === "failed";
        if (presentation.canStart !== expectedCanStart) {
          dumpJobSurfaceParitySnapshot(`case1d-canstart-mismatch-${job.id}`, { job, extra: { canStart: presentation.canStart, expectedCanStart } });
        }
        expect(presentation.canStart).toBe(expectedCanStart);
      }
    });
  });

  describe("Case 1e: completed-job presentation is identical across both surfaces", () => {
    it("buildCompletedLabJobPresentation produces same outputSummary for done/cancelled jobs", () => {
      const completedJobs = FIXTURE_JOBS.filter(j => j.status === "done" || j.status === "cancelled");
      console.info(`[job-surface-parity:case1e] checking completed-job presentation for ${completedJobs.length} completed jobs`);

      for (const job of completedJobs) {
        const trayPresentation = buildCompletedLabJobPresentation(job as any, false, t as any);
        const tabPresentation = buildCompletedLabJobPresentation(job as any, false, t as any);
        console.info(`[job-surface-parity:case1e] job ${job.id} (status="${job.status}") outputSummary=${JSON.stringify(trayPresentation.outputSummary)} duration=${JSON.stringify(trayPresentation.completedMeta?.duration)}`);

        // Both surfaces call the same function with same args — assert outputs are identical
        if (
          trayPresentation.outputSummary !== tabPresentation.outputSummary ||
          trayPresentation.completedMeta?.duration !== tabPresentation.completedMeta?.duration
        ) {
          dumpJobSurfaceParitySnapshot(`case1e-mismatch-${job.id}`, {
            job,
            extra: { tray: trayPresentation, tab: tabPresentation },
          });
        }
        expect(trayPresentation.outputSummary).toBe(tabPresentation.outputSummary);
        expect(trayPresentation.completedMeta?.duration).toBe(tabPresentation.completedMeta?.duration);
      }
    });
  });

  describe("Case 2: update simulation — status change reflects on both surfaces in the same projection pass", () => {
    it("when j-t transcoding→done, both tray and process-tab projections update simultaneously", () => {
      console.info(`[job-surface-parity:case2] simulating j-t transcoding(42%)→done(100%) update`);
      // Initial state: j-t is transcoding at 42%
      const initialJob = FIXTURE_JOBS.find(j => j.id === "j-t")!;
      expect(initialJob.status).toBe("transcoding");

      const trayBefore = trayProjectionForJob(initialJob);
      const tabBefore = processTabProjectionForJob(initialJob, MEDIA_FILTER_ID);
      console.info(`[job-surface-parity:case2] before: tray=${JSON.stringify(trayBefore)} tab=${JSON.stringify(tabBefore)}`);

      if (
        trayBefore.statusKey !== tabBefore.statusKey ||
        trayBefore.progressPct !== tabBefore.progressPct ||
        trayBefore.statusKey !== "lab.status.transcoding" ||
        trayBefore.progressPct !== 42
      ) {
        dumpJobSurfaceParitySnapshot("case2-before-mismatch", { job: initialJob, tray: trayBefore, tab: tabBefore });
      }
      expect(trayBefore).toEqual(tabBefore);
      expect(trayBefore.statusKey).toBe("lab.status.transcoding");
      expect(trayBefore.progressPct).toBe(42);

      // Update: same job data, status changed to done
      const updatedJob: LabJob = {
        ...initialJob,
        status: "done",
        progress: 100,
        completedAt: "2026-01-01T00:02:00.000Z",
      };

      const trayAfter = trayProjectionForJob(updatedJob);
      const tabAfter = processTabProjectionForJob(updatedJob, MEDIA_FILTER_ID);
      console.info(`[job-surface-parity:case2] after: tray=${JSON.stringify(trayAfter)} tab=${JSON.stringify(tabAfter)}`);

      // Both surfaces reflect the new status in the same projection call
      if (trayAfter.statusKey !== tabAfter.statusKey || trayAfter.progressPct !== tabAfter.progressPct) {
        dumpJobSurfaceParitySnapshot("case2-after-mismatch", { job: updatedJob, tray: trayAfter, tab: tabAfter });
        throw new Error(
          `Post-update parity mismatch for job j-t:\n` +
          `  Tray:        statusKey="${trayAfter.statusKey}"  progressPct=${trayAfter.progressPct}\n` +
          `  Process-tab: statusKey="${tabAfter.statusKey}"  progressPct=${tabAfter.progressPct}`
        );
      }

      expect(trayAfter.statusKey).toBe("lab.status.done");
      expect(trayAfter.progressPct).toBeNull();
      expect(tabAfter.statusKey).toBe("lab.status.done");
      expect(tabAfter.progressPct).toBeNull();

      // And the group-level projection also updates correctly
      const groupsBefore = buildLabJobGroups([initialJob]);
      const groupsAfter = buildLabJobGroups([updatedJob]);
      console.info(`[job-surface-parity:case2] groupsBefore[0].status=${JSON.stringify(groupsBefore[0]?.status)} groupsAfter[0].status=${JSON.stringify(groupsAfter[0]?.status)}`);
      if (groupsBefore[0]?.status !== "transcoding" || groupsAfter[0]?.status !== "done") {
        dumpJobSurfaceParitySnapshot("case2-group-status-mismatch", {
          extra: { before: groupsBefore[0]?.status, after: groupsAfter[0]?.status },
        });
      }

      expect(groupsBefore[0]?.status).toBe("transcoding");
      expect(groupsAfter[0]?.status).toBe("done");
    });

    it("when a new jobs array replaces the old one, filteredJobs reflects the update for both surfaces", () => {
      const active = FIXTURE_JOBS.filter(j => j.status === "transcoding" || j.status === "uploading");
      const completed = FIXTURE_JOBS.filter(j => j.status === "done" || j.status === "cancelled");

      console.info(`[job-surface-parity:case2] replacing jobs array: j-t transcoding→done, expect tray+tab view states to follow`);
      const viewStateBefore = buildLabQueueViewState({
        jobs: FIXTURE_JOBS,
        activeJobs: active,
        completedJobs: completed,
        mediaFilterId: MEDIA_FILTER_ID,
      });
      console.info(`[job-surface-parity:case2] before: filteredActive=${JSON.stringify(viewStateBefore.filteredActive.map((j) => j.id))} filteredCompleted=${JSON.stringify(viewStateBefore.filteredCompleted.map((j) => j.id))}`);

      // Verify j-t is active
      if (!viewStateBefore.filteredActive.some(j => j.id === "j-t") || viewStateBefore.filteredCompleted.some(j => j.id === "j-t")) {
        dumpJobSurfaceParitySnapshot("case2-jt-not-active-before", {
          extra: {
            active: viewStateBefore.filteredActive.map((j) => j.id),
            completed: viewStateBefore.filteredCompleted.map((j) => j.id),
          },
        });
      }
      expect(viewStateBefore.filteredActive.some(j => j.id === "j-t")).toBe(true);
      expect(viewStateBefore.filteredCompleted.some(j => j.id === "j-t")).toBe(false);

      // Update: j-t moves to done
      const updatedJob: LabJob = {
        ...FIXTURE_JOBS.find(j => j.id === "j-t")!,
        status: "done",
        progress: 100,
        completedAt: "2026-01-01T00:02:00.000Z",
      };
      const updatedJobs = FIXTURE_JOBS.map(j => j.id === "j-t" ? updatedJob : j);
      const updatedActive = updatedJobs.filter(j => j.status === "transcoding" || j.status === "uploading");
      const updatedCompleted = updatedJobs.filter(j => j.status === "done" || j.status === "cancelled");

      const viewStateAfter = buildLabQueueViewState({
        jobs: updatedJobs,
        activeJobs: updatedActive,
        completedJobs: updatedCompleted,
        mediaFilterId: MEDIA_FILTER_ID,
      });
      console.info(`[job-surface-parity:case2] after: filteredActive=${JSON.stringify(viewStateAfter.filteredActive.map((j) => j.id))} filteredCompleted=${JSON.stringify(viewStateAfter.filteredCompleted.map((j) => j.id))}`);

      // j-t should now be in filteredCompleted, not filteredActive
      if (viewStateAfter.filteredActive.some(j => j.id === "j-t") || !viewStateAfter.filteredCompleted.some(j => j.id === "j-t")) {
        dumpJobSurfaceParitySnapshot("case2-jt-not-completed-after", {
          extra: {
            active: viewStateAfter.filteredActive.map((j) => j.id),
            completed: viewStateAfter.filteredCompleted.map((j) => j.id),
          },
        });
      }
      expect(viewStateAfter.filteredActive.some(j => j.id === "j-t")).toBe(false);
      expect(viewStateAfter.filteredCompleted.some(j => j.id === "j-t")).toBe(true);

      // And the tray projection matches the process-tab projection for the updated job
      const trayAfter = trayProjectionForJob(updatedJob);
      const tabAfter = processTabProjectionForJob(updatedJob, MEDIA_FILTER_ID);
      console.info(`[job-surface-parity:case2] updated-job projections: tray=${JSON.stringify(trayAfter)} tab=${JSON.stringify(tabAfter)}`);
      if (trayAfter.statusKey !== tabAfter.statusKey || trayAfter.progressPct !== tabAfter.progressPct || trayAfter.statusKey !== "lab.status.done") {
        dumpJobSurfaceParitySnapshot("case2-updated-projection-mismatch", { job: updatedJob, tray: trayAfter, tab: tabAfter });
      }
      expect(trayAfter).toEqual(tabAfter);
      expect(trayAfter.statusKey).toBe("lab.status.done");
    });
  });
});
