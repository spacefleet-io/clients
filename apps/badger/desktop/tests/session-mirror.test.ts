/**
 * #25 product bug (see session-store.test.ts): the renderer's Chromium
 * localStorage can come back EMPTY after a SIGKILL/crash even though the app was
 * signed in. The renderer now mirrors the session keys to the main process and
 * refills an empty localStorage from main before AuthProvider's first render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hydrateSessionFromMain, persistSessionToMain } from "../src/renderer/src/lib/sessionMirror";

const TOKEN = "tok_live_9f2c1d7a";
const USER = JSON.stringify({ id: "u1", email: "a@b.c" });

describe("session mirror (renderer)", () => {
  const storage = new Map<string, string>();
  const replace = vi.fn<(entries: Record<string, string>) => Promise<unknown>>();
  let snapshot: Record<string, string>;

  beforeEach(() => {
    storage.clear();
    snapshot = {};
    replace.mockReset();
    replace.mockResolvedValue({ ok: true });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    });
    vi.stubGlobal("window", {
      localStorage: globalThis.localStorage,
      sf: { session: { get snapshot() { return snapshot; }, replace } },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dump = (label: string) =>
    console.error(
      `=== [session-mirror:${label}] storage=${JSON.stringify([...storage.entries()])} replace=${JSON.stringify(replace.mock.calls)}`,
    );

  it("@bugfix @regression-proof an EMPTY localStorage is refilled from the main-process copy (the post-kill login-page bug)", () => {
    snapshot = { sf_client_token: TOKEN, sf_client_user: USER, "sf_client_library_key:u1": "lk" };
    const restored = hydrateSessionFromMain();
    try {
      expect(storage.get("sf_client_token")).toBe(TOKEN);
      expect(storage.get("sf_client_user")).toBe(USER);
      expect(storage.get("sf_client_library_key:u1")).toBe("lk");
      expect(restored.sort()).toEqual(["sf_client_library_key:u1", "sf_client_token", "sf_client_user"]);
    } catch (err) {
      dump("hydrate-empty");
      throw err;
    }
  });

  it("never overwrites a value localStorage already has (it is the fresher copy)", () => {
    storage.set("sf_client_token", "newer");
    snapshot = { sf_client_token: TOKEN, sf_client_user: USER };
    hydrateSessionFromMain();
    expect(storage.get("sf_client_token")).toBe("newer");
    expect(storage.get("sf_client_user")).toBe(USER);
  });

  it("ignores non-session keys and malformed snapshots from main", () => {
    snapshot = { theme: "dark", sf_client_token: 7 } as unknown as Record<string, string>;
    expect(hydrateSessionFromMain()).toEqual([]);
    expect(storage.size).toBe(0);
    vi.stubGlobal("window", { localStorage: globalThis.localStorage, sf: {} });
    expect(hydrateSessionFromMain()).toEqual([]);
  });

  it("persistSessionToMain mirrors exactly the session keys currently in localStorage", async () => {
    storage.set("sf_client_token", TOKEN);
    storage.set("sf_client_user", USER);
    storage.set("sf_client_library_key_ack:u1", "true");
    storage.set("sf-api-base-url", "http://x");
    storage.set("theme", "dark");
    await persistSessionToMain();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toEqual({
      sf_client_token: TOKEN,
      sf_client_user: USER,
      "sf_client_library_key_ack:u1": "true",
    });
  });

  it("a logged-out localStorage mirrors as EMPTY so main can never resurrect the session", async () => {
    storage.set("theme", "dark");
    await persistSessionToMain();
    expect(replace).toHaveBeenCalledWith({});
  });

  it("a failing or absent main bridge never breaks the renderer", async () => {
    storage.set("sf_client_token", TOKEN);
    replace.mockRejectedValueOnce(new Error("ipc gone"));
    await expect(persistSessionToMain()).resolves.toBeUndefined();
    vi.stubGlobal("window", { localStorage: globalThis.localStorage });
    await expect(persistSessionToMain()).resolves.toBeUndefined();
  });
});

describe("session mirror wiring (source guards)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("@bugfix @regression-proof main.tsx hydrates from main BEFORE the first render", () => {
    const source = read("src/renderer/src/main.tsx");
    const hydrateAt = source.indexOf("hydrateSessionFromMain()");
    const renderAt = source.indexOf("const renderApp");
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(hydrateAt).toBeLessThan(renderAt);
  });

  it("@bugfix @regression-proof auth.tsx mirrors every session write and clear", () => {
    const source = read("src/renderer/src/auth.tsx");
    // setSession, the user-effect, the 401 clear, and both ends of logout.
    expect(source.match(/persistSessionToMain\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("@bugfix @regression-proof the library key writes and the full client reset mirror too", () => {
    expect(read("src/renderer/src/lib/onboarding.ts")).toContain("persistSessionToMain()");
    expect(read("src/renderer/src/lib/clientReset.ts")).toContain("persistSessionToMain()");
  });

  it("@bugfix @regression-proof preload exposes the session bridge and main registers its handlers", () => {
    const preload = read("src/preload/index.ts");
    expect(preload).toContain("SESSION_SNAPSHOT_CHANNEL");
    expect(preload).toContain("SESSION_REPLACE_CHANNEL");
    const main = read("src/main/index.ts");
    expect(main).toContain("registerSessionIpc");
  });
});
