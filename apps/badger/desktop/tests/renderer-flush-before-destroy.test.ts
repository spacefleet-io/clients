/**
 * @test-id RENDERER-FLUSH-BEFORE-DESTROY-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why Issue #25: close-to-tray closes the window with `win.destroy()`, which
 *      tears the renderer down without beforeunload / unload / pagehide. The
 *      cold-start library snapshot cache was only flushed on pagehide, so
 *      everything since the last debounced write (an entire playback session,
 *      since the debounce starved under progress writes) was lost, and a
 *      later tray "Quit" had no renderer left to flush. Pre-fix there is no
 *      flush handshake: `requestRendererFlush`, the preload bridge and the
 *      close-handler wiring do not exist.
 * @covers apps/badger/desktop/src/main/rendererFlush.ts
 * @covers apps/badger/desktop/src/main/index.ts
 * @covers apps/badger/desktop/src/preload/index.ts
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: (...args: unknown[]) => console.info("[renderer-flush:info]", JSON.stringify(args)),
    warn: (...args: unknown[]) => console.warn("[renderer-flush:warn]", JSON.stringify(args)),
    error: (...args: unknown[]) => console.error("[renderer-flush:error]", JSON.stringify(args)),
    debug: () => undefined,
  }),
}));

import {
  WINDOW_FLUSH_DONE_CHANNEL,
  WINDOW_FLUSH_REQUEST_CHANNEL,
  requestRendererFlush,
} from "../src/main/rendererFlush";

const TAG = "renderer-flush-before-destroy";

// Fake ipcMain + webContents. `respond` decides how the "renderer" reacts to a
// flush request: ack (after running its flush), ack with a wrong id, from a
// different window, or never.
const createFakes = (respond: "ack" | "wrong-id" | "other-sender" | "silent", webContentsId = 7) => {
  const ipcMain = new EventEmitter();
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const flushedInRenderer: number[] = [];
  let destroyed = false;
  const webContents = {
    id: webContentsId,
    isDestroyed: () => destroyed,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
      const requestId = args[0];
      if (respond === "silent") return;
      queueMicrotask(() => {
        flushedInRenderer.push(Number(requestId));
        const senderId = respond === "other-sender" ? webContentsId + 1 : webContentsId;
        const ackId = respond === "wrong-id" ? Number(requestId) + 1000 : requestId;
        ipcMain.emit(WINDOW_FLUSH_DONE_CHANNEL, { sender: { id: senderId } }, ackId, { callbacks: 2 });
      });
    },
  };
  return {
    ipcMain,
    webContents,
    sent,
    flushedInRenderer,
    destroy: () => {
      destroyed = true;
    },
    dump: (label: string, extra: Record<string, unknown> = {}) => {
      console.error(`=== [${TAG}:${label}] dump ===`);
      console.error(
        JSON.stringify(
          { sent, flushedInRenderer, listeners: ipcMain.listenerCount(WINDOW_FLUSH_DONE_CHANNEL), ...extra },
          null,
          2
        )
      );
    },
  };
};

describe("[@bugfix][@regression-proof] close-to-tray asks the renderer to flush before win.destroy()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves 'acked' once the renderer flushed, and removes its listener", async () => {
    const f = createFakes("ack");
    const outcome = await requestRendererFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 2_000 });
    console.info(`[${TAG}:ack] outcome=${outcome} sent=${JSON.stringify(f.sent)}`);
    try {
      expect(outcome).toBe("acked");
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0].channel).toBe(WINDOW_FLUSH_REQUEST_CHANNEL);
      expect(f.flushedInRenderer).toHaveLength(1);
      expect(f.ipcMain.listenerCount(WINDOW_FLUSH_DONE_CHANNEL)).toBe(0);
    } catch (err) {
      f.dump("ack", { outcome });
      throw err;
    }
  });

  // run 7950 tray-flow: the window was destroyed within 4 ms of the ack and
  // Playwright dropped the renderer's "[sf-window-flush]" console line, so the
  // e2e could not prove the handshake. Main now keeps the outcome + the
  // callback count the preload reported (SF_E2E only), which survives the window.
  it("[@bugfix][@regression-proof] records the handshake (outcome, callbacks) in main under SF_E2E", async () => {
    const previous = process.env.SF_E2E;
    process.env.SF_E2E = "1";
    globalThis.__sfLastRendererFlush = undefined;
    try {
      const f = createFakes("ack", 11);
      const outcome = await requestRendererFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 2_000 });
      // Read through a function: the `= undefined` above would otherwise narrow the global to `undefined`.
      const lastFlush = () => globalThis.__sfLastRendererFlush;
      const record = lastFlush();
      console.info(`[${TAG}:record] outcome=${outcome} record=${JSON.stringify(record)}`);
      expect(record).toMatchObject({ webContentsId: 11, outcome: "acked", callbacks: 2 });
      expect(typeof record?.requestId).toBe("number");

      const silent = createFakes("silent", 12);
      const pending = requestRendererFlush({ webContents: silent.webContents, ipcMain: silent.ipcMain, timeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBe("timeout");
      expect(globalThis.__sfLastRendererFlush).toMatchObject({ webContentsId: 12, outcome: "timeout", callbacks: null });
    } finally {
      if (previous === undefined) delete process.env.SF_E2E;
      else process.env.SF_E2E = previous;
      globalThis.__sfLastRendererFlush = undefined;
    }
  });

  it("ignores acks for another request or another window, then times out (bounded)", async () => {
    for (const mode of ["wrong-id", "other-sender"] as const) {
      const f = createFakes(mode);
      const pending = requestRendererFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(1_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, `${mode}: must still wait before the timeout`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      console.info(`[${TAG}:${mode}] outcome=${outcome}`);
      expect(outcome).toBe("timeout");
      expect(f.ipcMain.listenerCount(WINDOW_FLUSH_DONE_CHANNEL)).toBe(0);
    }
  });

  it("a hung renderer cannot keep the window alive: 'timeout' after timeoutMs", async () => {
    const f = createFakes("silent");
    const pending = requestRendererFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe("timeout");
    expect(f.ipcMain.listenerCount(WINDOW_FLUSH_DONE_CHANNEL)).toBe(0);
  });

  it("an already-destroyed renderer resolves 'gone' without sending", async () => {
    const f = createFakes("ack");
    f.destroy();
    expect(await requestRendererFlush({ webContents: f.webContents, ipcMain: f.ipcMain })).toBe("gone");
    expect(f.sent).toEqual([]);
  });

  // Since d0ff86fa4 the close handler is the shared `attachCloseToTray` (packages/desktop-shell); its hide → flush →
  // destroy order and the re-shown-window guard are tested in packages/desktop-shell/tests/main-shell.test.ts.
  // Here: Badger hands it destroy mode with the renderer flush as `beforeDestroy`.
  it("main wires close-to-tray in destroy mode with the renderer flush before destroy", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");
    const start = src.indexOf("attachCloseToTray(win, {");
    const region = start > -1 ? src.slice(start, src.indexOf("});", start)) : "";
    const checks = {
      found: start > -1,
      destroyMode: region.includes('background: "destroy"'),
      flushBeforeDestroy: region.includes("beforeDestroy: () => requestRendererFlush({ webContents: win.webContents, ipcMain })"),
    };
    console.info(`[${TAG}:main-wiring] checks=${JSON.stringify(checks)}`);
    try {
      expect(checks).toEqual({ found: true, destroyMode: true, flushBeforeDestroy: true });
    } catch (err) {
      console.error(region);
      throw err;
    }
  });

  it("preload answers on the same channels after running the callbacks", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)), "utf8");
    const start = src.indexOf(`ipcRenderer.on("${WINDOW_FLUSH_REQUEST_CHANNEL}"`);
    const region = src.slice(start, start + 700);
    const callbacksAt = region.indexOf("callback();");
    const ackAt = region.indexOf(`ipcRenderer.send("${WINDOW_FLUSH_DONE_CHANNEL}", requestId, { callbacks })`);
    const checks = {
      listens: start > -1,
      acksAfterCallbacks: callbacksAt > -1 && ackAt > callbacksAt,
      exposed: src.includes("onBeforeWindowDestroy: (callback: () => void) =>"),
    };
    console.info(`[${TAG}:preload-wiring] checks=${JSON.stringify(checks)}`);
    expect(checks).toEqual({ listens: true, acksAfterCallbacks: true, exposed: true });
  });
});
