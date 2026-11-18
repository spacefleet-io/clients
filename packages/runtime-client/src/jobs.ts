import type { SpaceAppId } from "@space/shared/appScope";
import type { RuntimeJobEventPayload, RuntimeJobFilter, RuntimeJobRecord } from "@space/runtime-jobs";
import type { RuntimeFetch } from "./fetch";

export type { RuntimeJobEventPayload, RuntimeJobFilter, RuntimeJobRecord } from "@space/runtime-jobs";

type WsLike = {
  addEventListener: (type: string, listener: (event?: unknown) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

type WsCtor = new (url: string) => WsLike;

type RuntimeJobsFrame = {
  eventId?: string;
  app?: SpaceAppId;
  channel?: string;
  payload?: {
    jobs?: RuntimeJobEventPayload[];
  };
};

const toWsBase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/runtime/events";
  url.search = "";
  return url;
};

const withSearch = (baseUrl: string, filter: RuntimeJobFilter = {}) => {
  const url = new URL("/runtime/jobs", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (filter.app) url.searchParams.set("app", filter.app);
  if (filter.status?.length) url.searchParams.set("status", filter.status.join(","));
  if (filter.kind?.length) url.searchParams.set("kind", filter.kind.join(","));
  if (filter.includeCompleted === true) url.searchParams.set("includeCompleted", "true");
  if (filter.limit && Number.isFinite(filter.limit) && filter.limit > 0) url.searchParams.set("limit", String(Math.floor(filter.limit)));
  return url.toString();
};

const authHeaders = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

const matchesRuntimeJobFilter = (job: RuntimeJobRecord, filter: RuntimeJobFilter = {}) => {
  if (filter.app && job.app !== filter.app) return false;
  if (filter.kind?.length && !filter.kind.includes(job.kind)) return false;
  if (filter.status?.length && !filter.status.includes(job.status)) return false;
  if (filter.includeCompleted !== true && ["succeeded", "failed", "cancelled"].includes(job.status)) return false;
  return true;
};

const applyRuntimeJobFrame = (
  current: RuntimeJobRecord[],
  frame: RuntimeJobsFrame,
  filter: RuntimeJobFilter = {}
) => {
  const updates = Array.isArray(frame.payload?.jobs) ? frame.payload.jobs : [];
  if (updates.length < 1) return { jobs: current, applied: false };

  const next = [...current];
  const indexById = new Map(next.map((job, index) => [job.jobId, index]));
  for (const update of updates) {
    const index = indexById.get(update.jobId);
    if (index === undefined) {
      return { jobs: current, applied: false };
    }
    const existing = next[index];
    if (!existing) return { jobs: current, applied: false };
    const merged: RuntimeJobRecord = {
      ...existing,
      app: update.app,
      kind: update.kind,
      status: update.status,
      stageCode: update.stageCode,
      stageLabel: update.stageLabel,
      progress: update.progress,
      payload:
        update.payload && typeof update.payload === "object"
          ? update.payload
          : existing.payload,
      outputs:
        update.outputs && typeof update.outputs === "object"
          ? update.outputs
          : existing.outputs,
      updatedAt: update.updatedAt,
      startedAt: update.startedAt === undefined ? existing.startedAt : update.startedAt,
      finishedAt: update.finishedAt === undefined ? existing.finishedAt : update.finishedAt,
      errorCode: update.errorCode ?? null,
      errorMessage: update.errorMessage ?? null,
      retryable: typeof update.retryable === "boolean" ? update.retryable : existing.retryable,
    };
    if (!matchesRuntimeJobFilter(merged, filter)) {
      next.splice(index, 1);
      indexById.delete(update.jobId);
      for (let cursor = index; cursor < next.length; cursor += 1) {
        indexById.set(next[cursor]!.jobId, cursor);
      }
      continue;
    }
    next[index] = merged;
  }
  return { jobs: next, applied: true };
};

export const listRuntimeJobs = async (args: {
  baseUrl: string;
  token: string;
  filter?: RuntimeJobFilter;
  fetchImpl?: RuntimeFetch;
}) => {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(withSearch(args.baseUrl.replace(/\/+$/, ""), args.filter), {
    method: "GET",
    headers: authHeaders(args.token),
  });
  if (!res.ok) throw new Error(`runtime_jobs_list_http_${res.status}`);
  const body = (await res.json()) as { items?: RuntimeJobRecord[] };
  return body.items ?? [];
};

export const getRuntimeJob = async (args: {
  baseUrl: string;
  token: string;
  jobId: string;
  fetchImpl?: RuntimeFetch;
}) => {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${args.baseUrl.replace(/\/+$/, "")}/runtime/jobs/${encodeURIComponent(args.jobId)}`, {
    method: "GET",
    headers: authHeaders(args.token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`runtime_jobs_get_http_${res.status}`);
  const body = (await res.json()) as { job?: RuntimeJobRecord | null };
  return body.job ?? null;
};

const mutateRuntimeJob = async (
  args: { baseUrl: string; token: string; jobId: string; fetchImpl?: RuntimeFetch },
  action: "cancel" | "retry"
) => {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${args.baseUrl.replace(/\/+$/, "")}/runtime/jobs/${encodeURIComponent(args.jobId)}/${action}`, {
    method: "POST",
    headers: authHeaders(args.token, { "content-type": "application/json" }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`runtime_jobs_${action}_http_${res.status}`);
  const body = (await res.json()) as { job?: RuntimeJobRecord | null };
  return body.job ?? null;
};

export const cancelRuntimeJob = (args: { baseUrl: string; token: string; jobId: string; fetchImpl?: RuntimeFetch }) =>
  mutateRuntimeJob(args, "cancel");

export const retryRuntimeJob = (args: { baseUrl: string; token: string; jobId: string; fetchImpl?: RuntimeFetch }) =>
  mutateRuntimeJob(args, "retry");

export const createRuntimeJobsStream = (args: {
  baseUrl: string;
  token: string;
  apps?: SpaceAppId[];
  filter?: RuntimeJobFilter;
  fetchImpl?: RuntimeFetch;
  WebSocketImpl?: WsCtor;
  pollMs?: number;
  reconnectMs?: number;
}) => {
  const fetchImpl = args.fetchImpl ?? fetch;
  const WebSocketImpl = args.WebSocketImpl ?? (WebSocket as unknown as WsCtor);
  const pollMs = args.pollMs ?? 3000;
  const reconnectMs = args.reconnectMs ?? 1500;
  const apps = args.apps ?? ["badger"];
  const listeners = new Set<(jobs: RuntimeJobRecord[]) => void>();
  let current: RuntimeJobRecord[] = [];
  let stopped = false;
  let ws: WsLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let lastEventId: string | null = null;
  let hasConnectedOnce = false;

  const notify = (jobs: RuntimeJobRecord[]) => {
    current = jobs;
    for (const listener of listeners) listener(jobs);
  };

  const refresh = async () => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const jobs = await listRuntimeJobs({
          baseUrl: args.baseUrl,
          token: args.token,
          filter: args.filter,
          fetchImpl,
        });
        notify(jobs);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  const stopPolling = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (pollTimer || stopped) return;
    pollTimer = setInterval(() => { refresh().catch(() => {}); }, pollMs);
  };

  const connectWs = () => {
    if (stopped) return;
    const wsUrl = toWsBase(args.baseUrl);
    wsUrl.searchParams.set("token", args.token);
    ws = new WebSocketImpl(wsUrl.toString());
    ws.addEventListener("open", () => {
      stopPolling();
      ws?.send(
        JSON.stringify({
          type: "subscribe",
          apps,
          channels: ["runtime.jobs"],
        })
      );
      if (lastEventId) {
        ws?.send(
          JSON.stringify({
            type: "ack",
            lastEventId,
          })
        );
      }
      refresh().catch(() => {});
      hasConnectedOnce = true;
    });
    ws.addEventListener("message", (event: unknown) => {
      const maybeData = (event as { data?: unknown } | undefined)?.data;
      if (typeof maybeData !== "string") return;
      let frame: RuntimeJobsFrame | null = null;
      try {
        frame = JSON.parse(maybeData) as RuntimeJobsFrame;
      } catch {
        return;
      }
      if (typeof frame?.eventId === "string" && frame.eventId) lastEventId = frame.eventId;
      if (frame?.app && frame.channel === "runtime.jobs") {
        const applied = applyRuntimeJobFrame(current, frame, args.filter);
        if (applied.applied) {
          notify(applied.jobs);
          return;
        }
        refresh().catch(() => {});
      }
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      startPolling();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, reconnectMs);
    });
  };

  return {
    start: async () => {
      stopped = false;
      await refresh();
      connectWs();
    },
    stop: () => {
      stopped = true;
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws) ws.close();
      ws = null;
    },
    subscribe: (listener: (jobs: RuntimeJobRecord[]) => void) => {
      listeners.add(listener);
      if (current.length > 0) listener(current);
      return () => listeners.delete(listener);
    },
    getCurrent: () => current,
  };
};
