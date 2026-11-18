/**
 * Close-to-tray flush handshake (issue #25).
 *
 * Background-to-tray closes the window with `win.destroy()`, which tears the
 * renderer down WITHOUT firing beforeunload / unload / pagehide. Anything the
 * renderer only writes on pagehide — the cold-start library snapshot cache —
 * was silently lost, and a later "Quit" from the tray has no renderer left to
 * flush. Before destroying, main asks the renderer to flush and waits for the
 * ack (bounded by a timeout so a hung or crashed renderer cannot keep the
 * window alive).
 *
 * The preload answers the request after running every
 * `window.sf.onBeforeWindowDestroy` callback synchronously.
 */
import { scopeLogger } from "./logger";

const logger = scopeLogger("renderer-flush");

export const WINDOW_FLUSH_REQUEST_CHANNEL = "sf-window-flush-request";
export const WINDOW_FLUSH_DONE_CHANNEL = "sf-window-flush-done";
export const WINDOW_FLUSH_TIMEOUT_MS = 2_000;

export type RendererFlushOutcome = "acked" | "timeout" | "gone";

export type RendererFlushTarget = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
};

type FlushDoneListener = (event: { sender: { id: number } }, requestId: unknown, details?: unknown) => void;

export type RendererFlushIpc = {
  on: (channel: string, listener: FlushDoneListener) => void;
  removeListener: (channel: string, listener: FlushDoneListener) => void;
};

/** The last flush handshake's result, kept in main so it survives the destroyed window. */
export type RendererFlushRecord = {
  requestId: number | null;
  webContentsId: number;
  outcome: RendererFlushOutcome;
  /** onBeforeWindowDestroy callbacks the preload ran, as reported in its ack (null without an ack). */
  callbacks: number | null;
  elapsedMs: number;
};

declare global {
  // E2E seam (SF_E2E=1 only): read via electronApp.evaluate after a close-to-tray.
  var __sfLastRendererFlush: RendererFlushRecord | undefined;
}

let nextRequestId = 1;

/** Keep the last handshake in main (SF_E2E only): the renderer console line dies with the window. */
const recordFlush = (record: RendererFlushRecord): void => {
  if (process.env.SF_E2E === "1") globalThis.__sfLastRendererFlush = record;
};

const ackedCallbackCount = (details: unknown): number | null => {
  if (typeof details !== "object" || details === null || !("callbacks" in details)) return null;
  return typeof details.callbacks === "number" ? details.callbacks : null;
};

export const requestRendererFlush = (deps: {
  webContents: RendererFlushTarget;
  ipcMain: RendererFlushIpc;
  timeoutMs?: number;
}): Promise<RendererFlushOutcome> => {
  const { webContents, ipcMain } = deps;
  const timeoutMs = deps.timeoutMs ?? WINDOW_FLUSH_TIMEOUT_MS;
  if (webContents.isDestroyed()) {
    logger.warn({ webContentsId: webContents.id }, "flush skipped: renderer already gone");
    recordFlush({ requestId: null, webContentsId: webContents.id, outcome: "gone", callbacks: null, elapsedMs: 0 });
    return Promise.resolve("gone");
  }
  const requestId = nextRequestId;
  nextRequestId += 1;
  const startedAt = Date.now();
  return new Promise<RendererFlushOutcome>((resolve) => {
    const finish = (outcome: RendererFlushOutcome, callbacks: number | null = null) => {
      clearTimeout(timer);
      ipcMain.removeListener(WINDOW_FLUSH_DONE_CHANNEL, onDone);
      const elapsedMs = Date.now() - startedAt;
      recordFlush({ requestId, webContentsId: webContents.id, outcome, callbacks, elapsedMs });
      if (outcome === "acked") {
        logger.info({ webContentsId: webContents.id, requestId, elapsedMs, callbacks }, "renderer flushed before window destroy");
      } else {
        logger.warn({ webContentsId: webContents.id, requestId, elapsedMs, outcome, timeoutMs }, "renderer flush not acknowledged");
      }
      resolve(outcome);
    };
    const onDone: FlushDoneListener = (event, ackId, details) => {
      if (event.sender.id !== webContents.id || ackId !== requestId) return;
      finish("acked", ackedCallbackCount(details));
    };
    ipcMain.on(WINDOW_FLUSH_DONE_CHANNEL, onDone);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      webContents.send(WINDOW_FLUSH_REQUEST_CHANNEL, requestId);
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "flush request send failed");
      finish("gone");
    }
  });
};
