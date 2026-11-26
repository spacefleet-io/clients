/**
 * @bugfix @regression-proof format-transcode-waits-for-source-upload (issue #25).
 *
 * Symptom: a format job (`badger.ingest.format.<quality>`, steps transcode →
 * upload → commit) only became runnable once its WHOLE source job had
 * succeeded, upload included. On a home connection the source upload of a
 * large file takes hours, so the 480p encode sat idle the whole time even
 * though the format lane was free and the transcode reads only the local
 * input file.
 *
 * Fix: parent gating is per step. A format `transcode` needs the source's
 * `extract` step done (probe data validated, local extraction finished); a
 * format `upload` needs the source's `upload` step done (the source keeps
 * network priority); a format `commit` still needs the whole source job
 * succeeded (it links to the source's committed file row). A source that
 * fails or is cancelled while a format step runs cancels the format job and
 * aborts its handler (encoder).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
  type StepHandlerCtx,
} from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "jobs-engine-v2-transcode-during-upload";
const ts = "2026-01-01T00:00:00.000Z";
const STEP_KINDS = ["probe", "identify", "extract", "transcode", "upload", "commit"] as const;
const SOURCE = "src-1";
const FORMAT = "fmt-480p";

const baseJob = (over: Partial<IngestJobRecord>): IngestJobRecord => ({
  jobId: "x",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: "u1" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...over,
});

const sourceJob = () => baseJob({ jobId: SOURCE, kind: "source", lane: "source", priority: 0 });
const formatJob = () =>
  baseJob({
    jobId: FORMAT,
    kind: "format",
    lane: "format",
    variant: "480p",
    priority: 30,
    parentJobIds: [SOURCE],
    payload: { userId: "u1", variant: "480p", parentSourceJobId: SOURCE },
  });

type Gate = {
  /** Settle to let the handler return / throw. */
  release: { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };
  aborted: boolean;
};

/**
 * Fake handlers. Every step records `start:<job>:<kind>` / `end:<job>:<kind>`
 * into a shared timeline. Steps listed in `hold` block until released (or
 * aborted — the abort rejects with an AbortError like the real ffmpeg/upload
 * deps do).
 */
const installHandlers = (engine: EngineV2, timeline: string[], hold: string[]) => {
  const gates = new Map<string, Gate>();
  for (const key of hold) {
    gates.set(key, {
      release: Promise.withResolvers<void>(),
      aborted: false,
    });
  }
  for (const kind of STEP_KINDS) {
    engine.registerHandler(kind, async (ctx: StepHandlerCtx) => {
      const key = `${ctx.job.jobId}:${kind}`;
      timeline.push(`start:${key}`);
      console.info(`[${SUITE}] handler start ${key} t=${Date.now()}`);
      const gate = gates.get(key);
      if (gate) {
        const onAbort = () => {
          gate.aborted = true;
          timeline.push(`abort:${key}`);
          console.info(`[${SUITE}] handler abort ${key}`);
          gate.release.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
        try {
          await gate.release.promise;
        } finally {
          ctx.signal.removeEventListener("abort", onAbort);
        }
      }
      timeline.push(`end:${key}`);
      console.info(`[${SUITE}] handler end ${key} t=${Date.now()}`);
    });
  }
  const gate = (key: string): Gate => {
    const g = gates.get(key);
    if (!g) throw new Error(`no gate for ${key}`);
    return g;
  };
  return { gate };
};

/**
 * Wait until `entry` shows up in the timeline. Dumps the engine state before
 * rethrowing so a timeout says WHERE the pipeline stalled.
 */
const waitFor = async (
  timeline: string[],
  entry: string,
  dump: (why: string) => Promise<void>
): Promise<void> => {
  try {
    await vi.waitFor(() => expect(timeline).toContain(entry), { timeout: 3000 });
  } catch (err) {
    await dump(`timeout waiting for ${entry}`);
    throw err;
  }
};

/**
 * Wait until a job's step has settled AND the job is back to `queued`: the
 * engine flips the job to queued and re-ticks in the same synchronous turn,
 * so once this holds every step the gating allows has already dispatched.
 */
const waitSettledBetweenSteps = async (
  e: EngineV2,
  jobId: string,
  kind: string,
  dump: (why: string) => Promise<void>
): Promise<void> => {
  try {
    await vi.waitFor(
      async () => {
        const got = await e.get(jobId);
        expect(got?.steps.find((s) => s.kind === kind)?.status).toBe("succeeded");
        expect(got?.job.status).toBe("queued");
      },
      { timeout: 3000 }
    );
  } catch (err) {
    await dump(`timeout waiting for ${jobId}:${kind} to settle`);
    throw err;
  }
};

describe(`[${SUITE}] format transcode runs while the source uploads`, () => {
  let tmp = "";
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[${SUITE}:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const boot = async (label: string, hold: string[]) => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-tdu-"));
    const dbPath = path.join(tmp, "jobs.db");
    console.info(`[${SUITE}:${label}] tmp=${tmp} hold=${JSON.stringify(hold)}`);
    const e = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1, uploadCap: 2, sourceCap: 2 });
    engine = e;
    await e.start();
    const timeline: string[] = [];
    const events: RuntimeJobEvent[] = [];
    e.subscribe((ev) => {
      events.push(ev);
      if (ev.event !== "runtime.jobs.progress") {
        console.info(`[${SUITE}:${label}] event ${ev.event} job=${ev.jobId}`);
      }
    });
    const { gate } = installHandlers(e, timeline, hold);
    const dump = async (why: string) => {
      const src = await e.get(SOURCE);
      const fmt = await e.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] DUMP(${why}) timeline=${JSON.stringify(timeline)}\n` +
          `  source status=${src?.job.status} code=${src?.job.errorCode} steps=${JSON.stringify(src?.steps.map((s) => `${s.kind}=${s.status}`))}\n` +
          `  format status=${fmt?.job.status} code=${fmt?.job.errorCode} steps=${JSON.stringify(fmt?.steps.map((s) => `${s.kind}=${s.status}`))}\n` +
          `  events=${JSON.stringify(events.filter((ev) => ev.event !== "runtime.jobs.progress").map((ev) => `${ev.event}:${ev.jobId}`))}`
      );
    };
    await e.submit(sourceJob());
    await e.submit(formatJob());
    return { e, timeline, events, gate, dump };
  };

  it("starts the format transcode while the source upload is held open, and commits the format only after the source commit", async () => {
    const label = "transcode-during-upload";
    const { e, timeline, gate, dump } = await boot(label, [
      `${SOURCE}:upload`,
      `${SOURCE}:commit`,
      `${FORMAT}:transcode`,
    ]);
    await waitFor(timeline, `start:${SOURCE}:upload`, dump);
    console.info(`[${SUITE}:${label}] source upload is running and held open`);

    // Pre-fix: the format job stays queued here until the source job succeeds.
    await waitFor(timeline, `start:${FORMAT}:transcode`, dump);
    await dump("transcode-started");
    expect(timeline).toContain(`start:${FORMAT}:transcode`);
    expect(timeline).not.toContain(`end:${SOURCE}:upload`);

    // Let the encode finish. The format upload must wait for the source
    // upload (network priority stays with the source).
    gate(`${FORMAT}:transcode`).release.resolve();
    await waitSettledBetweenSteps(e, FORMAT, "transcode", dump);
    await dump("transcode-done-source-still-uploading");
    expect(timeline).not.toContain(`start:${FORMAT}:upload`);
    const fmtMid = await e.get(FORMAT);
    expect(fmtMid?.job.status).toBe("queued");
    expect(fmtMid?.steps.find((s) => s.kind === "transcode")?.status).toBe("succeeded");

    // Source upload completes → source commit starts (held) → format upload
    // may run, format commit must NOT start while the source commit is held.
    gate(`${SOURCE}:upload`).release.resolve();
    await waitFor(timeline, `start:${SOURCE}:commit`, dump);
    await waitSettledBetweenSteps(e, FORMAT, "upload", dump);
    await dump("source-commit-held");
    expect(timeline).not.toContain(`start:${FORMAT}:commit`);

    gate(`${SOURCE}:commit`).release.resolve();
    await vi.waitFor(
      async () => {
        const fmt = await e.get(FORMAT);
        expect(fmt?.job.status).toBe("succeeded");
      },
      { timeout: 3000 }
    );
    await dump("all-done");
    const srcCommitEnd = timeline.indexOf(`end:${SOURCE}:commit`);
    const fmtCommitStart = timeline.indexOf(`start:${FORMAT}:commit`);
    const fmtTranscodeStart = timeline.indexOf(`start:${FORMAT}:transcode`);
    const srcUploadEnd = timeline.indexOf(`end:${SOURCE}:upload`);
    console.info(
      `[${SUITE}:${label}] order srcUploadEnd=${srcUploadEnd} fmtTranscodeStart=${fmtTranscodeStart} srcCommitEnd=${srcCommitEnd} fmtCommitStart=${fmtCommitStart}`
    );
    expect(fmtTranscodeStart).toBeGreaterThanOrEqual(0);
    expect(fmtTranscodeStart).toBeLessThan(srcUploadEnd);
    expect(srcCommitEnd).toBeGreaterThanOrEqual(0);
    expect(fmtCommitStart).toBeGreaterThan(srcCommitEnd);
    expect((await e.get(SOURCE))?.job.status).toBe("succeeded");
  });

  it("does not start the format transcode before the source extract has finished", async () => {
    const label = "transcode-waits-for-extract";
    const { timeline, gate, dump } = await boot(label, [`${SOURCE}:extract`]);
    // The extract dispatch and the format job's gating check run in the same
    // tick (source first by priority), so no later tick can sneak it in.
    await waitFor(timeline, `start:${SOURCE}:extract`, dump);
    await dump("extract-held");
    expect(timeline).not.toContain(`start:${FORMAT}:transcode`);
    gate(`${SOURCE}:extract`).release.resolve();
    await vi.waitFor(() => expect(timeline).toContain(`start:${FORMAT}:transcode`), { timeout: 3000 });
    expect(timeline.indexOf(`start:${FORMAT}:transcode`)).toBeGreaterThan(timeline.indexOf(`end:${SOURCE}:extract`));
  });

  it("cancels the running format job and aborts its encoder when the source upload fails mid-transcode", async () => {
    const label = "source-fails-during-transcode";
    const { e, timeline, events, gate, dump } = await boot(label, [`${SOURCE}:upload`, `${FORMAT}:transcode`]);
    await waitFor(timeline, `start:${SOURCE}:upload`, dump);
    await waitFor(timeline, `start:${FORMAT}:transcode`, dump);
    await dump("both-running");

    gate(`${SOURCE}:upload`).release.reject(new Error("STORAGE_GATEWAY_UNREACHABLE"));
    await vi.waitFor(
      async () => {
        const fmt = await e.get(FORMAT);
        expect(fmt?.job.status).toBe("cancelled");
      },
      { timeout: 3000 }
    );
    await vi.waitFor(
      async () => {
        const fmt = await e.get(FORMAT);
        expect(fmt?.steps.find((s) => s.kind === "transcode")?.status).toBe("cancelled");
      },
      { timeout: 3000 }
    );
    await dump("after-source-failure");
    expect((await e.get(SOURCE))?.job.status).toBe("failed");
    expect(gate(`${FORMAT}:transcode`).aborted).toBe(true);
    expect(timeline).toContain(`abort:${FORMAT}:transcode`);
    expect(timeline).not.toContain(`start:${FORMAT}:upload`);
    expect(timeline).not.toContain(`start:${FORMAT}:commit`);
    const fmt = await e.get(FORMAT);
    expect(fmt?.job.errorCode).toBe("parent-cancelled");
    expect(
      events.some((ev) => ev.event === "runtime.jobs.cancelled" && ev.jobId === FORMAT)
    ).toBe(true);
  });

  it("cancels the running format job and aborts its encoder when the user cancels the source mid-transcode", async () => {
    const label = "source-cancelled-during-transcode";
    const { e, timeline, gate, dump } = await boot(label, [`${SOURCE}:upload`, `${FORMAT}:transcode`]);
    await waitFor(timeline, `start:${SOURCE}:upload`, dump);
    await waitFor(timeline, `start:${FORMAT}:transcode`, dump);
    const res = await e.cancel(SOURCE, "user-cancelled");
    console.info(`[${SUITE}:${label}] cancel result ${JSON.stringify(res)}`);
    expect(res.cancelledIds).toEqual(expect.arrayContaining([SOURCE, FORMAT]));
    await vi.waitFor(
      async () => {
        const fmt = await e.get(FORMAT);
        expect(fmt?.steps.find((s) => s.kind === "transcode")?.status).toBe("cancelled");
      },
      { timeout: 3000 }
    );
    await dump("after-cancel");
    expect(gate(`${FORMAT}:transcode`).aborted).toBe(true);
    expect(timeline).not.toContain(`start:${FORMAT}:upload`);
  });

  it("resumes both the source upload and the format transcode after a restart mid-flight", async () => {
    const label = "restart-mid-flight";
    const first = await boot(label, [`${SOURCE}:upload`, `${FORMAT}:transcode`]);
    await waitFor(first.timeline, `start:${SOURCE}:upload`, first.dump);
    await waitFor(first.timeline, `start:${FORMAT}:transcode`, first.dump);
    await first.dump("before-stop");
    await first.e.stop();
    engine = null;

    const dbPath = path.join(tmp, "jobs.db");
    const second = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1, uploadCap: 2, sourceCap: 2 });
    engine = second;
    const timeline2: string[] = [];
    const { gate } = installHandlers(second, timeline2, [`${SOURCE}:upload`]);
    await second.start();
    const dump2 = async (why: string) => {
      console.info(`[${SUITE}:${label}] DUMP2(${why}) timeline2=${JSON.stringify(timeline2)}`);
    };
    await waitFor(timeline2, `start:${SOURCE}:upload`, dump2);
    // The resumed transcode runs (and finishes) while the resumed source
    // upload is still held open.
    await vi.waitFor(() => expect(timeline2).toContain(`end:${FORMAT}:transcode`), { timeout: 3000 });
    console.info(`[${SUITE}:${label}] timeline2=${JSON.stringify(timeline2)}`);
    expect(timeline2).not.toContain(`start:${SOURCE}:extract`);
    expect(timeline2).not.toContain(`start:${FORMAT}:commit`);
    gate(`${SOURCE}:upload`).release.resolve();
    await vi.waitFor(
      async () => {
        const fmt = await second.get(FORMAT);
        expect(fmt?.job.status).toBe("succeeded");
      },
      { timeout: 3000 }
    );
    expect(timeline2.indexOf(`start:${FORMAT}:commit`)).toBeGreaterThan(timeline2.indexOf(`end:${SOURCE}:commit`));
  });
});
