// @vitest-environment jsdom
//
// @bugfix @regression-proof #2499
// @req INGS-QUEUE-01
//
// Chris 2026-11-15: after a multi-file upload, queued transcodes read as
// started and frozen at 1 % until a restart. A queued job (new, or between
// two steps waiting for a lane slot) must read "Waiting · #N in line" with no
// stale stage label, and the runtime's `waiting` progress event must flip a
// running row back to waiting.

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { RuntimeJobsEvent } from "@space/runtime-contracts/runtime/jobs";
import {
  applyIngestJobEvent,
  buildIngestJobGroups,
  computeQueuePositions,
  ingestJobsToLabJobs,
  pickMostActiveJob,
  type IngestJobRecord,
} from "../src/renderer/src/lib/runtimeIngestJobs";
import { LabStatusBadge } from "../src/renderer/src/components/LabStatusBadge";
import { buildActiveLabJobPresentation } from "../src/renderer/src/components/labJobPresentation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = "[lab-queue-waiting-in-line]";

const DICT: Record<string, string> = {
  "lab.status.waiting": "Waiting",
  "lab.status.waitingInLine": "Waiting · #{{position}} in line",
  "lab.status.transcoding": "Transcoding",
  "lab.status.uploading": "Uploading",
  "lab.status.done": "Done",
  "lab.status.failed": "Failed",
  "lab.queue.transcode": "Transcode",
  "lab.queue.help.transcode": "Transcode help",
};

const translate = (key: string, opts?: string | Record<string, unknown>): string => {
  const template = DICT[key] ?? (typeof opts === "string" ? opts : key);
  if (!opts || typeof opts === "string") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts[name] ?? ""));
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

const record = (overrides: Partial<IngestJobRecord>): IngestJobRecord => ({
  jobId: "job",
  app: "badger",
  kind: "format",
  lane: "format",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { filename: "Saltmarsh.mkv", variant: "360p" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-11-15T05:34:00.000Z",
  updatedAt: "2026-11-15T05:34:00.000Z",
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: "360p",
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = async (element: React.ReactElement) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
};

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const dump = (label: string, value: unknown) => {
  try {
    console.error(`${T} === ${label} ===\n${JSON.stringify(value, null, 2)}`);
  } catch (err) {
    console.error(`${T} dump failed: ${String(err)}`);
  }
};

describe("queued jobs read as waiting, with their place in line", () => {
  it("numbers queued jobs in scheduler order and skips running ones", () => {
    const jobs = [
      record({ jobId: "c", createdAt: "2026-11-15T05:34:03.000Z" }),
      record({ jobId: "run", status: "running", createdAt: "2026-11-15T05:34:00.000Z" }),
      record({ jobId: "a", createdAt: "2026-11-15T05:34:01.000Z" }),
      record({ jobId: "urgent", priority: -1, createdAt: "2026-11-15T05:34:09.000Z" }),
      record({ jobId: "b", createdAt: "2026-11-15T05:34:01.000Z" }),
    ];
    const positions = computeQueuePositions(jobs);
    const lab = ingestJobsToLabJobs(jobs);
    const byId = Object.fromEntries(lab.map((j) => [j.id, j.queuePosition]));
    dump("positions", { positions: [...positions], byId });
    expect([...positions]).toEqual([
      ["urgent", 1],
      ["a", 2],
      ["b", 3],
      ["c", 4],
    ]);
    expect(byId).toEqual({ c: 4, run: undefined, a: 2, urgent: 1, b: 3 });
  });

  it("a waiting progress event turns a running row back into a waiting one", () => {
    const running = record({
      jobId: "fmt",
      status: "running",
      stageCode: "transcoding",
      stageLabel: "Transcoded 360p",
      progressPct: 100,
    });
    const event = {
      event: "runtime.jobs.progress",
      jobId: "fmt",
      groupId: "g1",
      progressPct: 100,
      stageCode: "waiting",
      stageLabel: "Waiting",
      uploadSpeedBytesPerSec: null,
      status: "queued",
    } satisfies Partial<RuntimeJobsEvent> as unknown as RuntimeJobsEvent;
    const next = applyIngestJobEvent(new Map([["fmt", running]]), event);
    const [lab] = ingestJobsToLabJobs([...next.values()]);
    dump("after-waiting-event", { rec: next.get("fmt"), lab });
    expect(next.get("fmt")?.status).toBe("queued");
    expect(lab.status).toBe("waiting");
    expect(lab.queuePosition).toBe(1);

    const presentation = buildActiveLabJobPresentation(lab, false, translate as never);
    dump("presentation", presentation);
    expect(presentation.outputLabel).not.toContain("Transcoded 360p");
    expect(presentation.outputLabel).not.toContain("Waiting");
  });

  it("badge reads 'Waiting · #2 in line' and never shows a percentage", async () => {
    await render(<LabStatusBadge status="waiting" stageLabel="Transcoded 360p" queuePosition={2} />);
    dump("badge", container?.innerHTML);
    expect(container?.textContent).toBe("Waiting · #2 in line");
    expect(container?.textContent).not.toMatch(/%/);
  });

  it("badge without a position still reads 'Waiting'", async () => {
    await render(<LabStatusBadge status="waiting" />);
    dump("badge-no-position", container?.innerHTML);
    expect(container?.textContent).toBe("Waiting");
  });

  // Hand try of #2520 (2026-11-16, 10-episode batch): at every hand-off
  // between "waiting" and "running" the badge lagged — rows read a bare
  // "Waiting" (or "Queued") beside a live % bar for 1–2 s, and an episode
  // header read "Done" while its jobs were still waiting.
  it("badge leaves 'Waiting' the moment the job starts, with no dwell", async () => {
    vi.useFakeTimers();
    try {
      await render(<LabStatusBadge status="uploading" stageLabel="Extracting" />);
      await act(async () => {
        root?.render(<LabStatusBadge status="waiting" stageLabel="Waiting" queuePosition={1} />);
      });
      dump("badge-entered-waiting", container?.textContent);
      expect(container?.textContent).toBe("Waiting · #1 in line");
      await act(async () => {
        root?.render(<LabStatusBadge status="uploading" stageLabel="Uploading" />);
      });
      dump("badge-left-waiting", container?.textContent);
      expect(container?.textContent).toBe("Uploading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a started job does not keep its queued stage label ('Waiting'/'Queued')", () => {
    for (const [stageCode, stageLabel] of [
      ["waiting", "Waiting"],
      ["queued", "Queued"],
    ] as const) {
      const queued = record({ jobId: "fmt", stageCode, stageLabel });
      const started = {
        event: "runtime.jobs.started",
        jobId: "fmt",
        groupId: "g1",
        kind: "format",
        variant: "360p",
        startedAt: "2026-11-15T05:35:00.000Z",
      } satisfies Partial<RuntimeJobsEvent> as unknown as RuntimeJobsEvent;
      const next = applyIngestJobEvent(new Map([["fmt", queued]]), started);
      const [lab] = ingestJobsToLabJobs([...next.values()]);
      dump(`started-from-${stageCode}`, lab);
      expect(lab.status).toBe("transcoding");
      expect(lab.stageLabel).toBeUndefined();
    }
  });

  it("an episode with a waiting job never reads 'Done' in its header", () => {
    const jobs = [
      record({ jobId: "src", kind: "source", lane: "source", status: "succeeded", stageCode: "done", stageLabel: "Done" }),
      record({ jobId: "fmt", stageCode: "waiting", stageLabel: "Waiting" }),
    ];
    const [group] = buildIngestJobGroups(jobs);
    const header = pickMostActiveJob(ingestJobsToLabJobs(jobs));
    dump("group", { status: group?.status, queuePosition: group?.queuePosition, header });
    expect(group?.status).toBe("waiting");
    expect(group?.queuePosition).toBe(1);
    expect(header?.status).toBe("waiting");
  });
});
