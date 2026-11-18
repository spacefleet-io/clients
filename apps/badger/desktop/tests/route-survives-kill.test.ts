/**
 * #25: after a SIGKILL / crash the app must reopen the LAST route, not /home.
 *
 * The session (token, user, library key) already has a durable main-process copy
 * (session-store.test.ts); `sf_last_authenticated_route` lived only in Chromium
 * localStorage, which an abrupt kill can hand back empty. It now rides the same
 * mirror, so a relaunch that gets an empty localStorage is refilled from main.
 *
 * "Kill + relaunch" here = wipe the stubbed localStorage (what the renderer sees
 * when Chromium loses it) and open a NEW session store on the same file (what main
 * sees after the process died with no shutdown hook).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretSafeStorage } from "@space/desktop-platform/secret-file";
import { createSessionStore, type SessionStore } from "../src/main/sessionStore";
import { isSessionStorageKey } from "../src/shared/sessionKeys";
import {
  clearLastAuthenticatedRoute,
  persistLastAuthenticatedRoute,
  readLastAuthenticatedRoute,
  resolveInitialAuthenticatedRoute,
} from "../src/renderer/src/lib/routePersistence";
import { hydrateSessionFromMain } from "../src/renderer/src/lib/sessionMirror";

const ROUTE_KEY = "sf_last_authenticated_route";
const TOKEN = "tok_live_9f2c1d7a";
const USER = JSON.stringify({ id: "u1", email: "a@b.c" });

const fakeSafeStorage = (): SecretSafeStorage => ({
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (plain) => Buffer.from(plain, "utf8").reverse(),
  decryptStringAsync: async (buf) => ({ result: Buffer.from(buf).reverse().toString("utf8"), shouldReEncrypt: false }),
});

describe("last authenticated route survives a kill (#25)", () => {
  const storage = new Map<string, string>();
  let dir: string;
  let filePath: string;
  let store: SessionStore;
  const logs: string[] = [];
  /** Mirror writes in flight (the renderer fires them without awaiting). */
  const pendingWrites: Promise<void>[] = [];

  /** Relaunch: main reopens its file; the renderer's localStorage is whatever Chromium hands back. */
  const relaunch = async (rendererStorage: Record<string, string> = {}) => {
    store = createSessionStore({ filePath, safeStorage: fakeSafeStorage(), log: (line) => logs.push(line) });
    await store.load(); // main awaits the async decrypt before creating the window
    storage.clear();
    for (const [key, value] of Object.entries(rendererStorage)) storage.set(key, value);
    const snapshot = store.read();
    vi.stubGlobal("window", {
      localStorage: globalThis.localStorage,
      sf: {
        session: {
          snapshot,
          replace: (entries: Record<string, string>) => {
            const write = store.replace(entries);
            pendingWrites.push(write);
            return write;
          },
        },
      },
    });
  };

  const dump = (label: string) =>
    console.error(
      `=== [route-survives-kill:${label}] storage=${JSON.stringify([...storage.entries()])} file=${(() => {
        try {
          return readFileSync(filePath, "utf8");
        } catch (err) {
          return `<${String(err)}>`;
        }
      })()} logs=${JSON.stringify(logs)}`,
    );

  /** Let the fire-and-forget mirror calls land (the real IPC is ordered, so is the store's queue). */
  const settle = async () => {
    await Promise.allSettled(pendingWrites.splice(0));
  };

  beforeEach(async () => {
    storage.clear();
    pendingWrites.length = 0;
    logs.length = 0;
    dir = mkdtempSync(join(tmpdir(), "sf-route-survives-"));
    filePath = join(dir, "session.json");
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    });
    await relaunch({ sf_client_token: TOKEN, sf_client_user: USER });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("@bugfix @regression-proof the route is part of the persisted session keys", () => {
    expect(isSessionStorageKey(ROUTE_KEY)).toBe(true);
  });

  it("@bugfix @regression-proof a persisted route is reopened after a kill that left localStorage empty", async () => {
    persistLastAuthenticatedRoute("/settings", "?section=video");
    await settle();
    try {
      expect(storage.get(ROUTE_KEY)).toBe("/settings?section=video");

      await relaunch({}); // SIGKILL + Chromium returned an empty localStorage
      expect(store.read()[ROUTE_KEY], "main must hold the route").toBe("/settings?section=video");
      hydrateSessionFromMain();
      expect(readLastAuthenticatedRoute()).toBe("/settings?section=video");
      expect(
        resolveInitialAuthenticatedRoute({
          isAuthenticated: true,
          loading: false,
          pathname: "/home",
          search: "",
          storedRoute: readLastAuthenticatedRoute(),
        }),
        "the shell must navigate to the last route instead of staying on /home",
      ).toBe("/settings?section=video");
    } catch (err) {
      dump("route-relaunch");
      throw err;
    }
  });

  it("@bugfix @regression-proof the LATEST route wins across several navigations before a kill", async () => {
    persistLastAuthenticatedRoute("/media-library", "?tab=movie");
    persistLastAuthenticatedRoute("/playlists", "");
    persistLastAuthenticatedRoute("/account", "");
    await settle();
    await relaunch({});
    try {
      expect(store.read()[ROUTE_KEY]).toBe("/account");
    } catch (err) {
      dump("latest-route");
      throw err;
    }
  });

  it("@bugfix @regression-proof a restored /home?media= route still resolves to a safe, restorable route (#203)", async () => {
    persistLastAuthenticatedRoute("/home", "?media=abc");
    await settle();
    await relaunch({});
    hydrateSessionFromMain();
    try {
      // The same restore decision route-persistence.test.ts pins: the cold boot on bare /home
      // restores the stored route, and the harness (#203) strips the query / clicks Home.
      expect(readLastAuthenticatedRoute()).toBe("/home?media=abc");
      expect(
        resolveInitialAuthenticatedRoute({
          isAuthenticated: true,
          loading: false,
          pathname: "/home",
          search: "",
          storedRoute: readLastAuthenticatedRoute(),
        }),
      ).toBe("/home?media=abc");
      // Once the user is on the bare Dashboard again the stored route is the bare Dashboard.
      persistLastAuthenticatedRoute("/home", "");
      await settle();
      await relaunch({});
      expect(store.read()[ROUTE_KEY]).toBe("/home");
    } catch (err) {
      dump("home-media");
      throw err;
    }
  });

  it("@bugfix @regression-proof clearing the route is durable: a relaunch never resurrects a cleared route", async () => {
    persistLastAuthenticatedRoute("/settings", "");
    await settle();
    clearLastAuthenticatedRoute();
    await settle();
    await relaunch({});
    try {
      expect(store.read()[ROUTE_KEY]).toBeUndefined();
      hydrateSessionFromMain();
      expect(readLastAuthenticatedRoute()).toBeNull();
      // The session itself is untouched by a route clear.
      expect(store.read().sf_client_token).toBe(TOKEN);
    } catch (err) {
      dump("clear-durable");
      throw err;
    }
  });

  it("a non-persistable route (login, bootstrap) is never mirrored", async () => {
    persistLastAuthenticatedRoute("/login", "");
    persistLastAuthenticatedRoute("/index.html", "");
    await settle();
    await relaunch({});
    expect(store.read()[ROUTE_KEY]).toBeUndefined();
  });

  it("a route in localStorage is never overwritten by main's older copy on hydrate", async () => {
    persistLastAuthenticatedRoute("/settings", "");
    await settle();
    await relaunch({ [ROUTE_KEY]: "/playlists" });
    hydrateSessionFromMain();
    expect(readLastAuthenticatedRoute()).toBe("/playlists");
  });
});

describe("route mirror wiring (source guards)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("@bugfix @regression-proof routePersistence mirrors both the write and the clear to main", () => {
    const source = read("src/renderer/src/lib/routePersistence.ts");
    const mirrors = source.match(/persistSessionToMain\(\)/g)?.length ?? 0;
    expect(mirrors, "persistLastAuthenticatedRoute and clearLastAuthenticatedRoute").toBeGreaterThanOrEqual(2);
    const setAt = source.indexOf("localStorage.setItem(LAST_ROUTE_KEY");
    const removeAt = source.indexOf("localStorage.removeItem(LAST_ROUTE_KEY");
    expect(source.indexOf("persistSessionToMain()", setAt)).toBeGreaterThan(setAt);
    expect(source.indexOf("persistSessionToMain()", removeAt)).toBeGreaterThan(removeAt);
  });
});
