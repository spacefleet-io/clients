// @vitest-environment jsdom
/**
 * @level integration (the real AuthProvider in a real React tree; jsdom localStorage; api and storage reset stubbed)
 * @bugfix @regression-proof
 * @req ACCT-DEV-01
 *
 * ACCT-DEV-01 (Chris 2026-10-16: "sign-out wipes key and cache"): the user's own Sign out forgets the library key on
 * the computer too, so signing back in asks for the key or a pairing. Before this fix the desktop `logout()` always
 * passed `preserveLibraryKey: true` to `resetClientStorage`, so a signed-out computer opened the library again without
 * asking. A session the server refused or ended (expired, signed out from another device, password changed, key
 * rotated) still keeps the key, as on the phone and Parrot (#1361, `keyAfterSignedOut`).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedOutReason } from "@space/shared/keptLibraryKey";
import { DESKTOP_TOUR_STORAGE_KEYS } from "@space/desktop-shell/tour";
import { AuthProvider, useAuth, type AuthContextValue } from "../src/renderer/src/auth";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "sign-out-forgets-library-key";

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

vi.mock("../src/renderer/src/api", () => api);
vi.mock("@space/desktop-shell/services/runtime-status", () => ({ useRuntimeInstanceId: () => 1 }));
vi.mock("@/lib/clientReset", () => reset);
vi.mock("@/lib/routePersistence", () => ({ clearLastAuthenticatedRoute: vi.fn() }));
vi.mock("@/lib/metadataTickets", () => ({
  setMetadataUrlOverride: vi.fn(),
  startMetadataTicketsAfterKeyStep: vi.fn(() => () => undefined),
  stopMetadataTickets: vi.fn(async () => undefined),
}));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});
vi.mock("@/lib/useClientConfig", () => ({
  useClientConfig: () => ({ uiLanguage: "en", maxParallelTranscodes: 1, maxParallelExtractions: 1 }),
}));

type Auth = AuthContextValue;

describe("desktop sign-out and the library key (ACCT-DEV-01)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let auth: Auth | null = null;

  const Probe = () => {
    auth = useAuth();
    return null;
  };

  const mount = async () => {
    console.info(`[${SUITE}] phase=mount token=${localStorage.getItem("sf_client_token") ? "set" : "none"}`);
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
  };

  const dump = (label: string) =>
    console.info(
      `[${SUITE}:${label}] resetClientStorage=${JSON.stringify(reset.resetClientStorage.mock.calls)} apiLogout=${api.logout.mock.calls.length} signedIn=${Boolean(auth?.token)}`,
    );

  const signOutWith = async (reason: SignedOutReason) => {
    await mount();
    expect(auth?.token).toBe("tok-1");
    console.info(`[${SUITE}] phase=logout reason=${reason}`);
    await act(async () => {
      await auth?.logout(reason);
    });
    dump(reason);
    expect(reset.resetClientStorage).toHaveBeenCalledTimes(1);
    expect(auth?.token).toBeNull();
    return reset.resetClientStorage.mock.calls[0]?.[0];
  };

  // The API host, and the once-per-computer tour marks (UX-TOUR-02).
  const KEPT_ON_SIGN_OUT = ["sf-api-base-url", ...DESKTOP_TOUR_STORAGE_KEYS];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sf_client_token", "tok-1");
    localStorage.setItem("sf_client_user", JSON.stringify({ id: "u1", email: "a@b.c" }));
    vi.clearAllMocks();
    auth = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("the user's own Sign out forgets the key, so signing in again asks for it", async () => {
    const options = await signOutWith("signOut");
    expect(options).toMatchObject({ preserveLibraryKey: false, preserveLocalStorageKeys: KEPT_ON_SIGN_OUT });
    expect(api.logout).toHaveBeenCalledWith("tok-1");
  });

  it("a session the server refused keeps the key, so signing in again opens the library", async () => {
    const options = await signOutWith("sessionRejected");
    expect(options).toMatchObject({ preserveLibraryKey: true, preserveLocalStorageKeys: KEPT_ON_SIGN_OUT });
  });
});
