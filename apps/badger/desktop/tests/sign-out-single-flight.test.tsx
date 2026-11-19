// @vitest-environment jsdom
/**
 * @level integration (the real AuthProvider in a real React tree; jsdom localStorage; api, tickets and reset stubbed)
 * @bugfix @regression-proof
 * @req ACCT-DEV-01
 *
 * badger-desktop-v0.1.16 release smoke (run 38822, [sign-out]): after Settings → Sign out the app sat on the
 * "Loading..." splash for 60 s. The user's `logout("signOut")` had revoked the session, then spent 59 s stopping the
 * metadata tickets; meanwhile the library sync got 401 with the revoked token, `handleForcedLogout` confirmed it
 * (`/auth/me` 401 twice, 300 ms apart) and started a SECOND `logout("sessionRejected")`. Both ran
 * `resetClientStorage` at once (two `clear-local-cache` 8 ms apart in main's log) and neither returned, so the
 * token was never cleared and /login never came.
 *
 * Pinned here: a logout while one runs joins it (one reset, one API logout, the first reason wins), and a local
 * cleanup step that never settles does not keep the app from reaching the sign-in screen (the steps inside
 * `resetClientStorage` are bounded the same way: tests/client-reset.test.ts).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth, type AuthContextValue } from "../src/renderer/src/auth";
import { LOGOUT_STEP_TIMEOUT_MS } from "../src/renderer/src/lib/logoutStep";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "sign-out-single-flight";

const api = vi.hoisted(() => ({
  getMe: vi.fn(async () => ({ user: { id: "u1", email: "a@b.c", uiLanguage: "en" } })),
  updateSettings: vi.fn(async () => ({ user: {} })),
  getSystemContract: vi.fn(async () => null),
  getSystemContractIssue: vi.fn(() => null),
  login: vi.fn(),
  logout: vi.fn(async () => undefined),
  setApiBaseUrl: vi.fn(),
}));
const reset = vi.hoisted(() => ({ resetClientStorage: vi.fn(async (_options?: Record<string, unknown>) => undefined) }));
const tickets = vi.hoisted(() => ({
  setMetadataUrlOverride: vi.fn(),
  startMetadataTicketsAfterKeyStep: vi.fn(() => () => undefined),
  stopMetadataTickets: vi.fn(async () => undefined),
}));
const logged = vi.hoisted(() => [] as { level: string; fields: Record<string, unknown>; msg: unknown }[]);

vi.mock("../src/renderer/src/api", () => api);
vi.mock("@space/desktop-shell/services/runtime-status", () => ({ useRuntimeInstanceId: () => 1 }));
vi.mock("@/lib/clientReset", () => reset);
vi.mock("@/lib/routePersistence", () => ({ clearLastAuthenticatedRoute: vi.fn() }));
vi.mock("@/lib/metadataTickets", () => tickets);
vi.mock("@/logger", () => {
  const at = (level: string) => (fields: Record<string, unknown>, msg?: unknown) => {
    logged.push({ level, fields, msg });
  };
  const log = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") };
  return { rendererLogger: { child: () => log, ...log } };
});
vi.mock("@/lib/useClientConfig", () => ({
  useClientConfig: () => ({ uiLanguage: "en", maxParallelTranscodes: 1, maxParallelExtractions: 1 }),
}));

describe("desktop sign-out runs once and always ends (run 38822)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let auth: AuthContextValue | null = null;

  const Probe = () => {
    auth = useAuth();
    return null;
  };

  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    console.info(`[${SUITE}] phase=mounted signedIn=${Boolean(auth?.token)}`);
  };

  const dump = (label: string) =>
    console.info(
      `[${SUITE}:${label}] resetClientStorage=${JSON.stringify(reset.resetClientStorage.mock.calls)} apiLogout=${api.logout.mock.calls.length} stopMetadataTickets=${tickets.stopMetadataTickets.mock.calls.length} signedIn=${Boolean(auth?.token)}\n  logs: ${logged.map((l) => `${l.level} ${String(l.msg)} ${JSON.stringify(l.fields)}`).join("\n        ")}`,
    );

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sf_client_token", "tok-1");
    localStorage.setItem("sf_client_user", JSON.stringify({ id: "u1", email: "a@b.c" }));
    vi.clearAllMocks();
    logged.length = 0;
    auth = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("a session-rejected logout during the user's sign-out joins it: one reset, one API logout, the user's reason", async () => {
    await mount();
    expect(auth?.token).toBe("tok-1");
    // The user's sign-out is held in the tickets step, like the 59 s of run 38822.
    const held = Promise.withResolvers<undefined>();
    tickets.stopMetadataTickets.mockImplementationOnce(() => held.promise);
    const logout = auth!.logout;
    let userDone = false;
    let rejectedDone = false;
    await act(async () => {
      const user = logout("signOut").then(() => (userDone = true));
      await new Promise((r) => setTimeout(r, 0));
      console.info(`[${SUITE}] phase=user-logout-held-in-tickets; the sync's 401 now starts logout("sessionRejected")`);
      const rejected = logout("sessionRejected").then(() => (rejectedDone = true));
      await new Promise((r) => setTimeout(r, 0));
      dump("both-started");
      held.resolve(undefined);
      await Promise.all([user, rejected]);
    });
    dump("both-done");
    expect(userDone && rejectedDone).toBe(true);
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(tickets.stopMetadataTickets).toHaveBeenCalledTimes(1);
    expect(reset.resetClientStorage).toHaveBeenCalledTimes(1);
    // The user asked to sign out: the key is forgotten (ACCT-DEV-01), whatever the 401 path would have kept.
    expect(reset.resetClientStorage.mock.calls[0]?.[0]).toMatchObject({ preserveLibraryKey: false });
    expect(auth?.token).toBeNull();
    expect(logged.some((l) => l.msg === "logout joins the one in progress")).toBe(true);
  });

  it("a logout after the first one finished runs again (the join lasts only while one is in progress)", async () => {
    await mount();
    await act(async () => {
      await auth!.logout("signOut");
    });
    localStorage.setItem("sf_client_token", "tok-2");
    await act(async () => {
      await auth!.logout("sessionRejected");
    });
    dump("sequential");
    expect(reset.resetClientStorage).toHaveBeenCalledTimes(2);
  });

  it("a metadata tickets stop that never settles is logged and passed: the app still signs out", async () => {
    await mount();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Never settled: run 38822 spent 59 s here before the reset even started.
    tickets.stopMetadataTickets.mockImplementationOnce(() => Promise.withResolvers<undefined>().promise);
    let done = false;
    await act(async () => {
      const run = auth!.logout("signOut").then(() => (done = true));
      await vi.advanceTimersByTimeAsync(LOGOUT_STEP_TIMEOUT_MS + 1);
      await run;
    });
    dump("hung-tickets");
    expect(done).toBe(true);
    expect(auth?.token).toBeNull();
    expect(localStorage.getItem("sf_client_token")).toBeNull();
    expect(reset.resetClientStorage).toHaveBeenCalledTimes(1);
    const timedOut = logged.filter((l) => l.msg === "logout step did not finish in time; signing out without it");
    expect(timedOut.map((l) => l.fields.step)).toEqual(["stopMetadataTickets"]);
  });
});
