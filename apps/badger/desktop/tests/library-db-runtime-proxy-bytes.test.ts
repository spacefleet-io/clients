/**
 * @req RT-CMD-05
 * @bugfix desktop-rotate-export-bytes
 * @why "Replace your library key" always failed with "Could not rotate the key": `exportLocalDb()` reached the
 *      runtime through this proxy, and the library image came back as JSON's index-keyed object (no `.buffer`), so
 *      `encryptBytesToBase64` threw before any request reached the API. The onboarding "recover from this computer"
 *      got a fixed empty Uint8Array from the proxy and would have uploaded an empty library.
 * @covers apps/badger/desktop/src/main/libraryDbRuntimeProxy.ts (`sf-library-db-call` exportBytes,
 *         `sf-library-db-seal-local-cache-for-rotation`), packages/runtime-client/src/command.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWireBytes } from "@space/runtime-contracts/wireBytes";
import { encryptBytesToBase64 } from "../src/renderer/src/lib/crypto";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../src/main/libraryDbAccessor", () => ({ setLibraryDbAccessorToken: vi.fn() }));
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import { registerLibraryDbRuntimeProxy, resetLibraryDbRuntimeProxyForTests } from "../src/main/libraryDbRuntimeProxy";

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;

/** A SQLite file's first bytes, as the runtime's `exportBytes` starts. */
const IMAGE = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00, 7, 8, 9]);
const KEY = Buffer.alloc(32, 7).toString("base64");
/** What the runtime's `LibraryDb.sealForRotation` answers (PRIV-KEY-13). */
const SEALED = {
  manifestBase64: "bWFuaWZlc3Q=",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "desktop-runtime", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Answers like the runtime: its route sends every command result through `encodeWireBytes` (RT-CMD-05). */
const runtimeFetch = (sentCommands: Array<{ command: string; payload: { method?: string } }>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href.includes("/runtime/session/login")) {
      return json({ ok: true, token: "rt", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: { apps: ["badger"] } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { command: string; payload: { method?: string } };
    sentCommands.push(body);
    const envelope = (result: unknown) => json(encodeWireBytes({ requestId: "r", ok: true, result, error: null }));
    if (body.command === "badger.db.status") return envelope({ open: true, version: 1, datasetStatus: { core: true, metadata: false, playback: false } });
    if (body.command === "badger.db.snapshot") return envelope({ media: [], mediaDetails: [], playlists: [], version: 1 });
    if (body.command === "badger.db.call" && body.payload.method === "exportBytes") return envelope(IMAGE);
    if (body.command === "badger.db.call" && body.payload.method === "sealForRotation") return envelope(SEALED);
    return envelope({});
  });

describe("library DB runtime proxy carries bytes [proxy-bytes] @req RT-CMD-05", () => {
  let handlers: Map<string, IpcHandler>;
  let sent: Array<{ command: string; payload: { method?: string } }>;

  beforeEach(async () => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    handlers = new Map();
    sent = [];
    vi.stubGlobal("fetch", runtimeFetch(sent));
    registerLibraryDbRuntimeProxy({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never);
  });

  const call = (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  it("exportBytes reaches the renderer as a Uint8Array that the rotation can encrypt", async () => {
    await call("sf-library-db-open", { token: "backend", keyBase64: KEY, userId: "user-1" });
    const bytes = await call("sf-library-db-call", { method: "exportBytes" });
    console.info(`[proxy-bytes:export] type=${Object.prototype.toString.call(bytes)} commands=${sent.map((c) => c.command).join(",")}`);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(IMAGE));
    // What `submitRecovery` does next; before the fix this threw "Cannot read properties of undefined (reading 'slice')".
    await expect(encryptBytesToBase64(KEY, bytes as Uint8Array)).resolves.toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("onboarding's recover seals the open library under the new key in the runtime (PRIV-KEY-13)", async () => {
    await call("sf-library-db-open", { token: "backend", keyBase64: KEY, userId: "user-1" });
    const sealed = await call("sf-library-db-seal-local-cache-for-rotation", { token: "backend", newKeyBase64: "new-key" });
    const forwarded = sent.find((c) => c.command === "badger.db.call" && c.payload.method === "sealForRotation");
    console.info(`[proxy-bytes:seal-local-cache] sealed=${JSON.stringify(sealed)} args=${JSON.stringify(forwarded?.payload)}`);
    expect(forwarded?.payload).toEqual({ method: "sealForRotation", args: ["new-key"] });
    expect(sealed).toEqual(SEALED);
  });

  it("with no library open there is nothing to seal (null: the screen says so instead of uploading nothing)", async () => {
    const sealed = await call("sf-library-db-seal-local-cache-for-rotation", { token: "backend", newKeyBase64: "new-key" });
    console.info(`[proxy-bytes:seal-local-cache-closed] value=${String(sealed)}`);
    expect(sealed).toBeNull();
    expect(sent.some((c) => c.payload.method === "sealForRotation")).toBe(false);
  });
});
