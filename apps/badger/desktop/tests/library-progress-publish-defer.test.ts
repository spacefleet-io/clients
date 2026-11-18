/**
 * @test-id PROGRESS-PUBLISH-DEFER-001
 * @bugfix @regression-proof
 *
 * Issue #25 — playback must cost no more than plain local mpv.
 *
 * While external mpv plays, the app window is hidden and the renderer saves
 * progress once a second through `sf-library-db-call`. Each save used to make
 * the runtime rebuild and publish the whole-library snapshot (~1 MB), and made
 * main spend a `badger.db.status` round trip plus a ~1 MB frame parse waiting
 * for read-your-writes nobody reads (the renderer holds progress-only frames
 * until the window shows). A `setProgress` from a hidden window now asks the
 * runtime to coalesce its frame (`deferPublish`) and does not refresh; a
 * visible window (and every other method) keeps the immediate behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const webContentsSendMock = vi.hoisted(() => vi.fn());
const windowMock = vi.hoisted(() => ({
  webContents: { send: webContentsSendMock, once: vi.fn(), isDestroyed: () => false },
  isDestroyed: () => false,
  once: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../src/main/libraryDbAccessor", () => ({
  setLibraryDbAccessorToken: vi.fn(),
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import { markAppWindowVisibility } from "../src/main/appWindowVisibility";
import { registerLibraryDbRuntimeProxy, resetLibraryDbRuntimeProxyForTests } from "../src/main/libraryDbRuntimeProxy";
import type { BrowserWindow } from "electron";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;
type RuntimeCommandBody = { command?: string; payload?: { method?: string; deferPublish?: boolean } };

const json = (result: unknown) =>
  new Response(JSON.stringify({ requestId: "r", ok: true, result, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("progress save from a hidden window (#25) @bugfix @regression-proof", () => {
  let handlers: Map<string, IpcHandler>;
  let commands: RuntimeCommandBody[];

  beforeEach(async () => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    webContentsSendMock.mockReset();
    commands = [];
    handlers = new Map();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes("/runtime/session/login")) {
          return new Response(
            JSON.stringify({ ok: true, token: "rt-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: { apps: ["badger"] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (!urlStr.includes("/modules/badger/commands")) return new Response("not found", { status: 404 });
        const body: RuntimeCommandBody = init?.body ? JSON.parse(String(init.body)) : {};
        commands.push(body);
        if (body.command === "badger.db.status") return json({ open: true, version: 1, datasetStatus: { core: true, metadata: true, playback: true } });
        if (body.command === "badger.db.snapshot") return json({ media: [], playlists: [], version: 1 });
        return json({});
      }),
    );
    const ipc = {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    };
    registerLibraryDbRuntimeProxy(ipc as never, () => windowMock as never);
    await handlers.get("sf-library-db-open")!({}, { token: "backend-token", keyBase64: "key123" });
    markAppWindowVisibility(windowMock as unknown as BrowserWindow, false, "test-reset");
    commands.length = 0;
  });

  const save = (pct: number) => handlers.get("sf-library-db-call")!({}, { method: "setProgress", args: ["m1", pct, "e1", null] });
  const calls = () => commands.filter((c) => c.command === "badger.db.call");
  const statuses = () => commands.filter((c) => c.command === "badger.db.status");

  it("hidden: 10 saves are 10 deferPublish calls and zero status/snapshot round trips", async () => {
    markAppWindowVisibility(windowMock as unknown as BrowserWindow, true, "external-mpv-hide");
    for (let pct = 1; pct <= 10; pct += 1) await save(pct);
    console.info(`[progress-publish-defer:hidden] commands=${JSON.stringify(commands.map((c) => [c.command, c.payload?.method, c.payload?.deferPublish]))}`);
    expect(calls()).toHaveLength(10);
    expect(calls().every((c) => c.payload?.deferPublish === true)).toBe(true);
    expect(statuses()).toHaveLength(0);
    expect(commands.filter((c) => c.command === "badger.db.snapshot")).toHaveLength(0);
  });

  it("visible: the save publishes immediately and keeps its read-your-writes refresh", async () => {
    await save(1);
    console.info(`[progress-publish-defer:visible] commands=${JSON.stringify(commands.map((c) => [c.command, c.payload?.method, c.payload?.deferPublish]))}`);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].payload?.deferPublish).toBeUndefined();
    expect(statuses().length).toBeGreaterThanOrEqual(1);
  });

  it("hidden: any other write is not deferred", async () => {
    markAppWindowVisibility(windowMock as unknown as BrowserWindow, true, "external-mpv-hide");
    await handlers.get("sf-library-db-call")!({}, { method: "setSetting", args: ["k", "v"] });
    console.info(`[progress-publish-defer:other-write] commands=${JSON.stringify(commands.map((c) => [c.command, c.payload?.method, c.payload?.deferPublish]))}`);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].payload?.deferPublish).toBeUndefined();
    expect(statuses().length).toBeGreaterThanOrEqual(1);
  });
});
