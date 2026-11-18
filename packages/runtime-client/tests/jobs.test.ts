import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelRuntimeJob,
  createRuntimeJobsStream,
  getRuntimeJob,
  listRuntimeJobs,
  retryRuntimeJob,
} from "../src/jobs";

const SUITE = "runtime-client-jobs";
const POLL_TAIL_MAX = 10;
const TRANSITION_TAIL_MAX = 20;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static envelopeTail: Array<{
    direction: "send" | "recv";
    at: number;
    payload: unknown;
  }> = [];
  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string) {
    this.sent.push(data);
    try {
      FakeWebSocket.envelopeTail.push({
        direction: "send",
        at: Date.now(),
        payload: JSON.parse(data),
      });
    } catch {
      FakeWebSocket.envelopeTail.push({
        direction: "send",
        at: Date.now(),
        payload: data,
      });
    }
    if (FakeWebSocket.envelopeTail.length > POLL_TAIL_MAX) {
      FakeWebSocket.envelopeTail.splice(
        0,
        FakeWebSocket.envelopeTail.length - POLL_TAIL_MAX,
      );
    }
  }

  close() {
    this.emit("close");
  }

  emit(type: string, event?: unknown) {
    if (type === "message") {
      try {
        const data = (event as { data?: unknown })?.data;
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        FakeWebSocket.envelopeTail.push({
          direction: "recv",
          at: Date.now(),
          payload: parsed,
        });
        if (FakeWebSocket.envelopeTail.length > POLL_TAIL_MAX) {
          FakeWebSocket.envelopeTail.splice(
            0,
            FakeWebSocket.envelopeTail.length - POLL_TAIL_MAX,
          );
        }
      } catch {
        // ignore tail-bookkeeping failures
      }
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const summarizeFetchCalls = (fetchMock: ReturnType<typeof vi.fn>) => {
  try {
    return fetchMock.mock.calls.slice(-POLL_TAIL_MAX).map((call, idx) => {
      const [url, init] = call as [unknown, unknown];
      const initRecord = (init && typeof init === "object" ? init : {}) as {
        method?: unknown;
      };
      return {
        idx,
        url,
        method: initRecord.method ?? "GET",
      };
    });
  } catch (err) {
    return `(fetch-trace failed: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const summarizeWsState = () => {
  try {
    return FakeWebSocket.instances.map((ws, idx) => ({
      idx,
      url: ws.url,
      sentCount: ws.sent.length,
      sent: ws.sent.map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return m;
        }
      }),
    }));
  } catch (err) {
    return `(ws-trace failed: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const dumpJobsSnapshot = (
  label: string,
  ctx: {
    fetchMock?: ReturnType<typeof vi.fn>;
    streamCurrent?: unknown;
    transitions?: unknown[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.fetchMock) {
      console.error(`fetch call count: ${ctx.fetchMock.mock.calls.length}`);
      console.error(
        `recent polls (last ${POLL_TAIL_MAX}):\n${JSON.stringify(
          summarizeFetchCalls(ctx.fetchMock),
          null,
          2,
        )}`,
      );
    }
    console.error(`fake ws instance count: ${FakeWebSocket.instances.length}`);
    console.error(
      `ws state:\n${JSON.stringify(summarizeWsState(), null, 2)}`,
    );
    console.error(
      `envelope tail (last ${POLL_TAIL_MAX}):\n${JSON.stringify(
        FakeWebSocket.envelopeTail,
        null,
        2,
      )}`,
    );
    if (ctx.streamCurrent !== undefined) {
      console.error(
        `stream.getCurrent() state:\n${JSON.stringify(ctx.streamCurrent, null, 2)}`,
      );
    }
    if (ctx.transitions) {
      console.error(
        `transition tail (last ${TRANSITION_TAIL_MAX}):\n${JSON.stringify(
          ctx.transitions.slice(-TRANSITION_TAIL_MAX),
          null,
          2,
        )}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const waitForCondition = async (
  predicateLabel: string,
  predicate: () => boolean,
  observeForLog: () => unknown,
  attempts = 25,
) => {
  const start = Date.now();
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      console.info(
        `[${SUITE}:wait] ${predicateLabel} satisfied attempts=${i + 1} elapsed=${Date.now() - start}ms`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  let observed: unknown;
  try {
    observed = observeForLog();
  } catch (err) {
    observed = `(observe failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  console.error(
    `[${SUITE}:wait] ${predicateLabel} TIMEOUT attempts=${attempts} elapsed=${Date.now() - start}ms observed=${JSON.stringify(observed)}`,
  );
  throw new Error("condition_not_met");
};

describe("runtime-client jobs", () => {
  console.info(`[${SUITE}:setup] runtime-jobs WS+poll suite`);

  afterEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.envelopeTail = [];
    vi.useRealTimers();
  });

  it("lists and gets shared runtime jobs", async () => {
    console.info(`[${SUITE}:list-get] preparing list+get mock responses`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { jobId: "parrot:job:1", app: "parrot", kind: "parrot.sync.upload" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          job: { jobId: "parrot:job:1", app: "parrot", kind: "parrot.sync.upload" },
        }),
      );

    try {
      await expect(
        listRuntimeJobs({
          baseUrl: "http://127.0.0.1:3020",
          token: "rt-token",
          filter: { app: "parrot", includeCompleted: true, status: ["running"] },
          fetchImpl: fetchMock,
        }),
      ).resolves.toEqual([
        { jobId: "parrot:job:1", app: "parrot", kind: "parrot.sync.upload" },
      ]);
      console.info(`[${SUITE}:list-get] listRuntimeJobs OK`);

      await expect(
        getRuntimeJob({
          baseUrl: "http://127.0.0.1:3020",
          token: "rt-token",
          jobId: "parrot:job:1",
          fetchImpl: fetchMock,
        }),
      ).resolves.toEqual({
        jobId: "parrot:job:1",
        app: "parrot",
        kind: "parrot.sync.upload",
      });
      console.info(`[${SUITE}:list-get] getRuntimeJob OK`);
    } catch (err) {
      dumpJobsSnapshot("list-get-mismatch", {
        fetchMock,
      });
      throw err;
    }
  });

  it("cancels and retries shared runtime jobs", async () => {
    console.info(`[${SUITE}:cancel-retry] preparing cancel+retry mock responses`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ job: { jobId: "parrot:job:1", status: "cancelled" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          job: { jobId: "badger:ingest:active:job-1", status: "running" },
        }),
      );

    try {
      await expect(
        cancelRuntimeJob({
          baseUrl: "http://127.0.0.1:3020",
          token: "rt-token",
          jobId: "parrot:job:1",
          fetchImpl: fetchMock,
        }),
      ).resolves.toEqual({ jobId: "parrot:job:1", status: "cancelled" });
      console.info(`[${SUITE}:cancel-retry] cancelRuntimeJob OK`);

      await expect(
        retryRuntimeJob({
          baseUrl: "http://127.0.0.1:3020",
          token: "rt-token",
          jobId: "badger:ingest:active:job-1",
          fetchImpl: fetchMock,
        }),
      ).resolves.toEqual({
        jobId: "badger:ingest:active:job-1",
        status: "running",
      });
      console.info(`[${SUITE}:cancel-retry] retryRuntimeJob OK`);
    } catch (err) {
      dumpJobsSnapshot("cancel-retry-mismatch", {
        fetchMock,
      });
      throw err;
    }
  });

  it("applies pushed runtime.jobs updates locally, replays by lastEventId on reconnect, and polls while disconnected @bugfix @regression-proof", async () => {
    console.info(
      `[${SUITE}:push-replay] WS push + reconnect with lastEventId ack + poll-while-disconnected`,
    );
    const transitions: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ jobId: "parrot:job:1", app: "parrot" }] }),
      )
      .mockResolvedValue(
        jsonResponse({
          items: [{ jobId: "badger:ingest:active:job-1", app: "badger" }],
        }),
      );

    const stream = createRuntimeJobsStream({
      baseUrl: "http://127.0.0.1:3020",
      token: "rt-token",
      fetchImpl: fetchMock,
      WebSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      pollMs: 1000,
      reconnectMs: 500,
    });

    try {
      await stream.start();
      console.info(`[${SUITE}:push-replay] stream started`);
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      const pushFrame = {
        eventId: "evt-1",
        app: "parrot",
        channel: "runtime.jobs",
        payload: {
          jobs: [
            {
              jobId: "parrot:job:1",
              app: "parrot",
              kind: "parrot.sync.upload",
              status: "running",
              stageCode: "uploading",
              stageLabel: "Uploading",
              progress: {
                mode: "fraction",
                completed: 5,
                total: 10,
                unit: "items",
              },
              updatedAt: "2026-03-23T10:00:00.000Z",
              errorCode: null,
            },
          ],
        },
      };
      transitions.push({ at: "before-push", evt: pushFrame.eventId });
      ws.emit("message", { data: JSON.stringify(pushFrame) });

      await waitForCondition(
        "push applied stageCode=uploading",
        () =>
          (stream.getCurrent()[0] as { stageCode?: string } | undefined)
            ?.stageCode === "uploading",
        () => stream.getCurrent(),
      );
      transitions.push({ at: "after-push", current: stream.getCurrent() });

      // Initial refresh + unconditional refresh on WS open
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(ws.sent).toContain(
        JSON.stringify({
          type: "subscribe",
          apps: ["badger"],
          channels: ["runtime.jobs"],
        }),
      );
      console.info(
        `[${SUITE}:push-replay] subscribe frame sent, current=${JSON.stringify(stream.getCurrent())}`,
      );

      vi.useFakeTimers();
      ws.emit("close");
      transitions.push({ at: "ws-close" });
      console.info(
        `[${SUITE}:push-replay] ws closed; advancing 1100ms to trigger poll`,
      );
      await vi.advanceTimersByTimeAsync(1100);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      console.info(
        `[${SUITE}:push-replay] advancing 500ms more to trigger reconnect`,
      );
      await vi.advanceTimersByTimeAsync(500);
      const ws2 = FakeWebSocket.instances[1];
      transitions.push({ at: "reconnect", wsCount: FakeWebSocket.instances.length });
      ws2.emit("open");
      expect(ws2.sent).toContain(
        JSON.stringify({
          type: "subscribe",
          apps: ["badger"],
          channels: ["runtime.jobs"],
        }),
      );
      expect(ws2.sent).toContain(
        JSON.stringify({ type: "ack", lastEventId: "evt-1" }),
      );
      console.info(
        `[${SUITE}:push-replay] OK ack frame replays lastEventId=evt-1`,
      );
    } catch (err) {
      dumpJobsSnapshot("push-replay-flow-broken", {
        fetchMock,
        streamCurrent: stream.getCurrent(),
        transitions,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof preserves pushed canonical payload details on runtime.jobs stream updates so Badger completion consumers can finalize locally", async () => {
    console.info(
      `[${SUITE}:preserve-payload] verify pushed payload preserved through state`,
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            jobId: "badger:ingest:user-1:job-1",
            app: "badger",
            kind: "badger.ingest.media_file",
            status: "running",
            stageCode: "uploading",
            stageLabel: "Uploading",
            progress: {
              mode: "fraction",
              completed: 80,
              total: 100,
              unit: "percent",
            },
            payload: {
              id: "job-1",
              filename: "/tmp/movie.mkv",
              matchedMediaId: "media-1",
            },
            outputs: {},
            errorCode: null,
            errorMessage: null,
            retryable: false,
            cancelRequested: false,
            priority: 0,
            dedupeKey: null,
            createdAt: "2026-03-23T10:00:00.000Z",
            updatedAt: "2026-03-23T10:00:00.000Z",
            startedAt: "2026-03-23T10:00:01.000Z",
            finishedAt: null,
          },
        ],
      }),
    );

    const stream = createRuntimeJobsStream({
      baseUrl: "http://127.0.0.1:3020",
      token: "rt-token",
      filter: {
        includeCompleted: true,
        app: "badger",
        kind: ["badger.ingest.media_file"],
      },
      fetchImpl: fetchMock,
      WebSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });

    const transitions: unknown[] = [];
    try {
      await stream.start();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      await waitForCondition(
        "initial snapshot length=1",
        () => stream.getCurrent().length === 1,
        () => ({ length: stream.getCurrent().length, current: stream.getCurrent() }),
      );
      transitions.push({ at: "initial", current: stream.getCurrent() });

      ws.emit("message", {
        data: JSON.stringify({
          eventId: "evt-badger-done",
          app: "badger",
          channel: "runtime.jobs",
          payload: {
            jobs: [
              {
                jobId: "badger:ingest:user-1:job-1",
                app: "badger",
                kind: "badger.ingest.media_file",
                status: "succeeded",
                stageCode: "done",
                stageLabel: "Done",
                progress: {
                  mode: "fraction",
                  completed: 100,
                  total: 100,
                  unit: "percent",
                },
                payload: {
                  id: "job-1",
                  filename: "/tmp/movie.mkv",
                  matchedMediaId: "media-1",
                  produced: {
                    videoFormats: [{ quality: "1080p", codec: "h264" }],
                  },
                },
                outputs: { fileId: "file-1" },
                updatedAt: "2026-03-23T10:01:00.000Z",
                startedAt: "2026-03-23T10:00:01.000Z",
                finishedAt: "2026-03-23T10:01:00.000Z",
                errorCode: null,
                errorMessage: null,
                retryable: false,
              },
            ],
          },
        }),
      });

      await waitForCondition(
        "status transitions to succeeded",
        () =>
          (stream.getCurrent()[0] as { status?: string } | undefined)?.status ===
          "succeeded",
        () => stream.getCurrent(),
      );
      transitions.push({ at: "after-done", current: stream.getCurrent() });

      expect(stream.getCurrent()).toEqual([
        expect.objectContaining({
          jobId: "badger:ingest:user-1:job-1",
          status: "succeeded",
          payload: expect.objectContaining({
            matchedMediaId: "media-1",
            produced: expect.objectContaining({
              videoFormats: [{ quality: "1080p", codec: "h264" }],
            }),
          }),
          outputs: { fileId: "file-1" },
          finishedAt: "2026-03-23T10:01:00.000Z",
        }),
      ]);
      console.info(
        `[${SUITE}:preserve-payload] OK canonical payload preserved through transition`,
      );
    } catch (err) {
      dumpJobsSnapshot("preserve-payload-lost-details", {
        fetchMock,
        streamCurrent: stream.getCurrent(),
        transitions,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof falls back to snapshot refresh when a pushed runtime.jobs delta references an unknown job", async () => {
    console.info(
      `[${SUITE}:unknown-job-refresh] verify delta for unknown job triggers refresh`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ jobId: "parrot:job:1", app: "parrot" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { jobId: "parrot:job:1", app: "parrot" },
            { jobId: "parrot:job:2", app: "parrot" },
          ],
        }),
      );

    const stream = createRuntimeJobsStream({
      baseUrl: "http://127.0.0.1:3020",
      token: "rt-token",
      fetchImpl: fetchMock,
      WebSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });

    const transitions: unknown[] = [];
    try {
      await stream.start();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      transitions.push({ at: "ws-open", current: stream.getCurrent() });

      ws.emit("message", {
        data: JSON.stringify({
          eventId: "evt-unknown",
          app: "parrot",
          channel: "runtime.jobs",
          payload: {
            jobs: [
              {
                jobId: "parrot:job:2",
                app: "parrot",
                kind: "parrot.sync.upload",
                status: "running",
                stageCode: "uploading",
                stageLabel: "Uploading",
                progress: {
                  mode: "fraction",
                  completed: 1,
                  total: 2,
                  unit: "items",
                },
                updatedAt: "2026-03-23T10:05:00.000Z",
                errorCode: null,
              },
            ],
          },
        }),
      });
      transitions.push({ at: "delta-pushed", eventId: "evt-unknown" });

      await waitForCondition(
        "snapshot grows to length=2 via fallback refresh",
        () => stream.getCurrent().length === 2,
        () => ({ length: stream.getCurrent().length, current: stream.getCurrent() }),
      );
      transitions.push({ at: "after-refresh", current: stream.getCurrent() });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      console.info(
        `[${SUITE}:unknown-job-refresh] OK fallback refresh fired (fetchCount=${fetchMock.mock.calls.length})`,
      );
    } catch (err) {
      dumpJobsSnapshot("unknown-job-refresh-flow-broken", {
        fetchMock,
        streamCurrent: stream.getCurrent(),
        transitions,
      });
      throw err;
    }
  });
});
