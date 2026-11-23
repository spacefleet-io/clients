import { describe, expect, it } from "vitest";

import {
  hasProcessingLabJobs,
  splitLabJobsByCompletion,
} from "../src/renderer/src/lib/labJobsState";

// Dump-on-failure: surface the input jobs + computed split so a
// completion/terminal-state classification mismatch is diagnosable without
// rerun. Wrapped in try/catch so a dump failure can never mask the real
// assertion.
const dumpLabJobsSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [lab-jobs-state:${label}] snapshot ===`);
    console.error(`ctx:\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("lab jobs state helpers", () => {
  const activeJob = {
    id: "j-1",
    filename: "Episode 1.mkv",
    status: "ready",
    progress: 0,
    createdAt: "2026-03-25T10:00:00.000Z",
  } as any;
  const doneJob = {
    id: "j-2",
    filename: "Episode 2.mkv",
    status: "done",
    progress: 100,
    createdAt: "2026-03-25T11:00:00.000Z",
  } as any;

  it("splits active and completed jobs deterministically", () => {
    console.info(`[lab-jobs-state:split] splitting 1 active (ready) + 1 done job`);
    const split = splitLabJobsByCompletion([activeJob, doneJob]);
    console.info(`[lab-jobs-state:split] active=${split.activeJobs.length} completed=${split.completedJobs.length}`);
    try {
      expect(splitLabJobsByCompletion([activeJob, doneJob])).toEqual({
        activeJobs: [activeJob],
        completedJobs: [doneJob],
      });
    } catch (err) {
      dumpLabJobsSnapshot("split", { input: [activeJob, doneJob], split });
      throw err;
    }
  });

  it("detects whether any job still keeps the window in a processing state", () => {
    console.info(`[lab-jobs-state:processing] checking ready vs failed+done sets`);
    const readyProcessing = hasProcessingLabJobs([activeJob]);
    const terminalSet = [
      { ...doneJob, status: "failed" },
      { ...activeJob, status: "done" },
    ] as any;
    const terminalProcessing = hasProcessingLabJobs(terminalSet);
    console.info(`[lab-jobs-state:processing] readyProcessing=${readyProcessing} terminalProcessing=${terminalProcessing}`);
    try {
      expect(hasProcessingLabJobs([activeJob])).toBe(true);
      expect(
        hasProcessingLabJobs([
          { ...doneJob, status: "failed" },
          { ...activeJob, status: "done" },
        ] as any)
      ).toBe(false);
    } catch (err) {
      dumpLabJobsSnapshot("processing", { readyProcessing, terminalSet, terminalProcessing });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] treats cancelled jobs as terminal instead of keeping them in active processing state", () => {
    console.info(`[lab-jobs-state:cancelled-terminal] verifying cancelled job is terminal, not active`);
    const cancelledJob = { ...activeJob, status: "cancelled" } as any;
    const split = splitLabJobsByCompletion([cancelledJob]);
    const processing = hasProcessingLabJobs([cancelledJob]);
    console.info(`[lab-jobs-state:cancelled-terminal] active=${split.activeJobs.length} completed=${split.completedJobs.length} processing=${processing}`);
    try {
      expect(splitLabJobsByCompletion([cancelledJob])).toEqual({
        activeJobs: [],
        completedJobs: [cancelledJob],
      });
      expect(hasProcessingLabJobs([cancelledJob])).toBe(false);
    } catch (err) {
      dumpLabJobsSnapshot("cancelled-terminal", { cancelledJob, split, processing });
      throw err;
    }
  });
});
