/**
 * Desktop profiles: the renderer's profile choice reaches the library in the main process (ACCT-SQUAD-02, UX-PROF-01).
 *
 * "Who's watching?" can be answered before the library is open, and the proxy refuses generic library calls until it
 * is, so the choice goes through its own bridge channel (`sf-library-db-set-active-profile`): main keeps it, gives it
 * to every library it opens (and to a respawned runtime), and forgets it at sign-out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../src/main/libraryDbAccessor", () => ({ setLibraryDbAccessorToken: vi.fn() }));
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("@/api", async () => {
  const shared = await vi.importActual<typeof import("@space/shared/api")>("@space/shared/api");
  return { ApiError: shared.ApiError, ...api };
});
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});
const downloadToSinkMock = vi.hoisted(() => vi.fn());
vi.mock("../src/main/forceGc", () => ({ runFullGc: () => ({ ms: 1 }) }));
vi.mock("../src/main/api", async () => {
  const actual = await vi.importActual<typeof MainApi>("../src/main/api");
  return { ...actual, downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args) };
});
vi.stubEnv("SF_PLAYBACK_OBJECT_FETCH_RETRY_DELAY_MS", "0");

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import { registerLibraryDbRuntimeProxy, resetLibraryDbRuntimeProxyForTests } from "../src/main/libraryDbRuntimeProxy";
import { getActivePlaybackProfileId } from "../src/main/activePlaybackProfile";
import { LibraryDb } from "../src/renderer/src/lib/libraryDb";
import { PlaybackServer } from "../src/main/playbackServer";
import type * as MainApi from "../src/main/api";

const LOG = "[profiles-bridge]";
const KIDS = { id: "prof-kids", isMain: false };
const CHRIS = { id: "prof-chris", isMain: true };

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
type Command = { command: string; payload?: { method?: string; args?: unknown[] } };
type PlaybackFetcher = { fetchObjectViaTunnel: (key: string) => Promise<Buffer> };
const readSentProfile = (options: unknown): unknown =>
  typeof options === "object" && options !== null && "profileId" in options ? options.profileId : null;

const createRuntimeFetch = () => {
  const commands: Command[] = [];
  let version = 1;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href.includes("/runtime/session/login")) {
      return json({ ok: true, token: "rt-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: { apps: ["badger"] } });
    }
    if (href.includes("/modules/badger/commands")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Command;
      commands.push(body);
      if (body.command === "badger.db.call") version += 1;
      if (body.command === "badger.db.snapshot") return json({ requestId: "r", ok: true, result: { media: [], playlists: [], version }, error: null });
      if (body.command === "badger.db.status") {
        return json({ requestId: "r", ok: true, result: { open: true, version, datasetStatus: { core: true, metadata: true, playback: true } }, error: null });
      }
      return json({ requestId: "r", ok: true, result: {}, error: null });
    }
    return new Response("not found", { status: 404 });
  });
  const profileCalls = () =>
    commands.filter((c) => c.command === "badger.db.call" && c.payload?.method === "setActiveProfile").map((c) => c.payload?.args?.[0]);
  return { fetchMock, commands, profileCalls };
};

describe("desktop active profile bridge", () => {
  let handlers: Map<string, IpcHandler>;
  let runtime: ReturnType<typeof createRuntimeFetch>;

  const dump = (label: string) =>
    console.error(
      `${LOG} ${label}`,
      JSON.stringify({
        commands: runtime.commands.map((c) => `${c.command}${c.payload?.method ? `:${c.payload.method}` : ""}`),
        profileCalls: runtime.profileCalls(),
        playbackProfileId: getActivePlaybackProfileId(),
        handlers: [...handlers.keys()].filter((k) => k.includes("profile")),
      }),
    );

  const invoke = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    console.info(`${LOG} invoke ${channel} ${JSON.stringify(payload ?? null)}`);
    return handler({}, payload);
  };

  beforeEach(async () => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => undefined);
    handlers = new Map();
    runtime = createRuntimeFetch();
    vi.stubGlobal("fetch", runtime.fetchMock);
    registerLibraryDbRuntimeProxy({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // @req UX-PROF-01[badger-desktop]
  it("preload exposes the set-active-profile channel and the renderer uses it instead of the generic call", async () => {
    const preload = readFileSync(join(__dirname, "../src/preload/index.ts"), "utf8");
    const types = readFileSync(join(__dirname, "../src/renderer/src/vite-env.d.ts"), "utf8");
    console.info(`${LOG} preload has channel=${preload.includes("sf-library-db-set-active-profile")}`);
    expect(preload).toMatch(/setActiveProfile:\s*\(profile[^)]*\)\s*=>\s*ipcRenderer\.invoke\("sf-library-db-set-active-profile", profile\)/);
    expect(types).toMatch(/setActiveProfile\?: \(profile: \{ id: string; isMain: boolean \} \| null\) => Promise<\{ applied: boolean \}>/);

    const setActiveProfile = vi.fn(async () => ({ applied: false }));
    const call = vi.fn(async () => {
      throw new Error("library not open");
    });
    vi.stubGlobal("window", { sf: { libraryDb: { setActiveProfile, call } } });
    const result = await LibraryDb.setActiveProfile(KIDS);
    console.info(`${LOG} renderer result=${JSON.stringify(result)} bridgeCalls=${JSON.stringify(setActiveProfile.mock.calls)}`);
    expect(result).toEqual({ applied: false });
    expect(setActiveProfile).toHaveBeenCalledWith(KIDS);
    expect(call).not.toHaveBeenCalled();
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  // @req UX-PROF-01[badger-desktop]
  it("a choice made before the library opens is kept and applied when it opens", async () => {
    try {
      const deferred = await invoke("sf-library-db-set-active-profile", KIDS);
      expect(deferred).toEqual({ applied: false });
      expect(runtime.profileCalls()).toEqual([]);
      expect(getActivePlaybackProfileId()).toBe(KIDS.id);

      await invoke("sf-library-db-open", { token: "backend-A", keyBase64: "key" });
      dump("after open");
      expect(runtime.profileCalls()).toEqual([KIDS]);

      const switched = await invoke("sf-library-db-set-active-profile", CHRIS);
      dump("after switch");
      expect(switched).toEqual({ applied: true });
      expect(runtime.profileCalls()).toEqual([KIDS, CHRIS]);
      expect(getActivePlaybackProfileId()).toBe(CHRIS.id);
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  it("sign-out forgets the choice, so the next library opens on no profile until one is picked", async () => {
    try {
      await invoke("sf-library-db-set-active-profile", KIDS);
      await invoke("sf-library-db-clear-local-cache");
      expect(getActivePlaybackProfileId()).toBeNull();
      await invoke("sf-library-db-open", { token: "backend-B", keyBase64: "key" });
      dump("after reopen");
      expect(runtime.profileCalls()).toEqual([]);
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  it("@bugfix refuses an empty id, a blank id, an id with ':' or a non-object, keeping the current profile", async () => {
    try {
      await invoke("sf-library-db-open", { token: "backend-C", keyBase64: "key" });
      await invoke("sf-library-db-set-active-profile", KIDS);
      const refused: Array<{ bad: unknown; result: unknown }> = [];
      for (const bad of [{ id: "", isMain: false }, { id: "   ", isMain: true }, { id: "prof-kids:evil", isMain: false }, { id: 42 }, "prof-kids"]) {
        refused.push({ bad, result: await invoke("sf-library-db-set-active-profile", bad) });
      }
      dump("after refused ids");
      console.info(`${LOG} refused`, JSON.stringify(refused));
      expect(refused.map((r) => r.result)).toEqual(Array(5).fill({ applied: false }));
      expect(runtime.profileCalls()).toEqual([KIDS]);
      expect(getActivePlaybackProfileId()).toBe(KIDS.id);
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // STOR-BW-11 (PR 826): the main process names the active profile on every playback request, from
  // `activePlaybackProfile`. The renderer store must reach it on every path: the picker skipped for a single profile,
  // a pick in "Who's watching?", and a switch inside the app.
  // @req UX-PROF-01[badger-desktop]
  // @req UX-PROF-02[badger-desktop]
  it("every profile the renderer lands on, including a single profile with no picker, becomes main's playback profile", async () => {
    const { profileStore } = await import("../src/renderer/src/lib/profileStore");
    const bridgeCalls: unknown[] = [];
    vi.stubGlobal("window", {
      sf: {
        libraryDb: {
          setActiveProfile: async (profile: unknown) => {
            bridgeCalls.push(profile);
            return await invoke("sf-library-db-set-active-profile", profile);
          },
        },
      },
    });
    const state = () => ({ snapshot: profileStore.getSnapshot(), bridgeCalls, playbackProfileId: getActivePlaybackProfileId() });
    try {
      const only = { id: "prof-only", name: "Only", isMain: true, createdAt: "2026-10-01T00:00:00.000Z" };
      api.listProfiles.mockResolvedValue({ profiles: [only], maxProfiles: 5 });
      await profileStore.startSession({ userId: "user-single", token: "tok", askEveryStart: true });
      // applyScope runs off the store's emit: wait for its effect, not a guessed delay.
      await vi.waitFor(() => expect(getActivePlaybackProfileId()).toBe("prof-only"));
      console.info(`${LOG} single profile`, JSON.stringify(state()));
      expect(profileStore.getSnapshot().needsChoice).toBe(false);
      expect(getActivePlaybackProfileId()).toBe("prof-only");
      await profileStore.endSession("user-single");
      await vi.waitFor(() => expect(getActivePlaybackProfileId()).toBeNull());

      const chris = { ...CHRIS, name: "Chris", createdAt: "2026-10-01T00:00:00.000Z" };
      const kids = { ...KIDS, name: "Kids", createdAt: "2026-10-02T00:00:00.000Z" };
      api.listProfiles.mockResolvedValue({ profiles: [chris, kids], maxProfiles: 5 });
      await profileStore.startSession({ userId: "user-two", token: "tok", askEveryStart: true });
      await vi.waitFor(() => expect(profileStore.getSnapshot().status).toBe("ready"));
      expect(profileStore.getSnapshot().needsChoice).toBe(true);
      await profileStore.selectProfile(KIDS.id);
      await vi.waitFor(() => expect(getActivePlaybackProfileId()).toBe(KIDS.id));
      console.info(`${LOG} picked kids`, JSON.stringify(state()));
      expect(getActivePlaybackProfileId()).toBe(KIDS.id);

      profileStore.askAgain();
      await profileStore.selectProfile(CHRIS.id);
      await vi.waitFor(() => expect(getActivePlaybackProfileId()).toBe(CHRIS.id));
      console.info(`${LOG} switched to chris`, JSON.stringify(state()));
      expect(getActivePlaybackProfileId()).toBe(CHRIS.id);
      await profileStore.endSession("user-two");
    } catch (error) {
      console.error(`${LOG} failed`, JSON.stringify(state()));
      dump("failed");
      throw error;
    }
  });

  // STOR-BW-11: end to end on desktop, a profile picked through the renderer's bridge channel is the one the playback
  // server names on its next storage request, and a switch moves the next request to the new profile.
  // @req STOR-BW-11[badger-desktop]
  it("a playback request after a pick names the picked profile, and follows a switch", async () => {
    const sent = () => downloadToSinkMock.mock.calls.map((call) => readSentProfile(call[3]));
    try {
      downloadToSinkMock.mockReset();
      downloadToSinkMock.mockResolvedValue({ bytes: 0 });
      const server = new PlaybackServer({});
      server.setToken("test-token");
      const fetchSegment = (key: string) => (server as unknown as PlaybackFetcher).fetchObjectViaTunnel(key);

      expect(await invoke("sf-library-db-set-active-profile", KIDS)).toEqual({ applied: false });
      await fetchSegment("seg-kids");
      expect(await invoke("sf-library-db-set-active-profile", CHRIS)).toEqual({ applied: false });
      await fetchSegment("seg-chris");
      console.info(`${LOG} playback profiles`, JSON.stringify(sent()));
      expect(sent()).toEqual([KIDS.id, CHRIS.id]);
      expect(downloadToSinkMock.mock.calls[1]?.[3]).toMatchObject({ purpose: "playback", profileId: CHRIS.id });
    } catch (error) {
      console.error(`${LOG} playback failed`, JSON.stringify({ sent: sent(), calls: downloadToSinkMock.mock.calls.length }));
      dump("failed");
      throw error;
    }
  });
});
