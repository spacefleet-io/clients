/**
 * Follows the account's Parrot library on the API's `/library/db/stream` (Server-Sent Events, LIB-SYNC-05/09) while the
 * app is open, so a change saved on another device opens here within seconds (PAR-SYNC-01). Each message is the
 * library's status; Parrot opens snapshots only, so the newest snapshot's version is what it reads. The first message
 * of every connection is the current status, which also covers what changed while the stream was down. The API ends
 * the stream every few minutes and the phone may lose it; it connects again after a short wait.
 *
 * React Native has no `EventSource`: its `XMLHttpRequest` hands over the body as it arrives (readyState 3), which is
 * all a stream of `data:` lines needs.
 */

type Log = (event: string, payload: Record<string, unknown>) => void;

/** The part of `XMLHttpRequest` the stream uses (a stand-in in tests). */
export type StreamRequest = {
  open: (method: string, url: string) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: () => void;
  abort: () => void;
  readyState: number;
  status: number;
  responseText: string;
  onreadystatechange: (() => void) | null;
  onerror: (() => void) | null;
};

/** Waits before connecting again: 1 s, 2 s, 4 s … up to 30 s; a stream that delivered a status starts over at 1 s. */
export const streamRetryDelay = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures));

/** The newest snapshot's version from one stream message; `null` for anything that is not a library status. */
export const parseSnapshotVersion = (data: string): number | null => {
  let meta: { version?: unknown; snapshotVersion?: unknown; exists?: unknown };
  try {
    meta = JSON.parse(data) as typeof meta;
  } catch {
    return null;
  }
  if (meta === null || typeof meta !== "object" || meta.exists === false || typeof meta.version !== "number") return null;
  return typeof meta.snapshotVersion === "number" ? meta.snapshotVersion : meta.version;
};

/** Splits what arrived so far into complete events; returns the `data` of each `message` event and the leftover text. */
export const readStreamEvents = (text: string): { messages: string[]; rest: string } => {
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const messages: string[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === "message" && data.length) messages.push(data.join("\n"));
  }
  return { messages, rest };
};

/** Connects to the stream and keeps it connected; `onSnapshot(version)` for every status. Returns the stop function. */
export const followLibrarySnapshots = (input: {
  apiBaseUrl: string;
  token: string;
  onSnapshot: (snapshotVersion: number) => void;
  request?: () => StreamRequest;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: Log;
}): (() => void) => {
  const log = input.log ?? (() => undefined);
  const request = input.request ?? (() => new XMLHttpRequest() as unknown as StreamRequest);
  const setTimer = input.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
  const url = `${input.apiBaseUrl.replace(/\/+$/u, "")}/library/db/stream?token=${encodeURIComponent(input.token)}&app=parrot`;
  let stopped = false;
  let failures = 0;
  let current: StreamRequest | null = null;
  let timer: unknown = null;

  const retry = (reason: string) => {
    if (stopped) return;
    current = null;
    const delay = streamRetryDelay(failures);
    failures += 1;
    log("parrot.library.stream.retry", { reason, delayMs: delay });
    timer = setTimer(() => {
      timer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    const xhr = request();
    current = xhr;
    let read = 0;
    let pending = "";
    let ended = false;
    const end = (reason: string) => {
      if (ended || current !== xhr) return;
      ended = true;
      retry(reason);
    };
    xhr.onreadystatechange = () => {
      if (current !== xhr) return;
      if (xhr.readyState >= 3 && xhr.status === 200) {
        const text = xhr.responseText ?? "";
        const { messages, rest } = readStreamEvents(pending + text.slice(read));
        read = text.length;
        pending = rest;
        for (const data of messages) {
          const version = parseSnapshotVersion(data);
          if (version === null) continue;
          failures = 0;
          input.onSnapshot(version);
        }
      }
      if (xhr.readyState === 4) end(xhr.status === 200 ? "closed" : `status ${xhr.status}`);
    };
    xhr.onerror = () => end("error");
    xhr.open("GET", url);
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Cache-Control", "no-cache");
    xhr.send();
    log("parrot.library.stream.connect", {});
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const open = current;
    current = null;
    open?.abort();
  };
};
