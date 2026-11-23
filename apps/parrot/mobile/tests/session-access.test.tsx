/**
 * @test-id PARROT-MOBILE-SESSION-ACCESS-001
 * @level unit
 * @req ACCT-UNPAID-03[parrot]
 * @req ACCT-UNPAID-03[parrot-tv]
 * @why Chris 2026-11-23 (#3350 S4): Parrot shows the same unpaid notice as Badger's phone and TV. The session reads the
 *   account's access from `/auth/me` (the same read that brings the account's language) at start, after a sign-in and
 *   each time the app comes back to the front, so an account that stops paying sees the notice without signing in
 *   again; signed out nothing is known and nothing shows, and a failed read keeps what was known.
 *
 * Mounts the real SessionProvider; the stores and the API are stand-ins.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellAuthSession } from "@space/mobile-shell/services/auth";

const SUITE = "[PARROT-MOBILE-SESSION-ACCESS-001]";

const ctl = vi.hoisted(() => ({
  stored: null as ShellAuthSession | null,
  key: null as string | null,
  access: undefined as { state: string; wipeAt: string | null } | undefined,
  meFails: false,
  reads: [] as string[],
  appState: [] as Array<(status: string) => void>,
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      ctl.appState.push(listener);
      return { remove: () => void (ctl.appState = ctl.appState.filter((other) => other !== listener)) };
    },
  },
  Platform: { OS: "android", isTV: false },
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => "en",
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/mobile-shell/account-language-prompt", () => ({
  askAccountLanguage: async () => "en",
}));
vi.mock("@space/shared/api", () => ({
  logout: async () => undefined,
  // The kept-key check (UX-KEY-01) gets no answer here: no verdict, so the key stays.
  getLibraryMeta: async () => {
    throw new Error("offline");
  },
  getMe: async (token: string) => {
    ctl.reads.push(token);
    if (ctl.meFails) throw new TypeError("Network request failed");
    return { user: { id: "u1", email: "a@b.c", uiLanguage: undefined, preferences: {}, access: ctl.access } };
  },
  updateSettings: async () => ({ user: {} }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("../src/lib/i18n", () => ({
  setParrotLanguage: async () => undefined,
}));
vi.mock("../src/lib/stores", () => ({
  sessionStore: { read: async () => ctl.stored, write: async () => undefined },
  libraryKeyStore: { get: async () => ctl.key, set: async () => undefined, clear: async () => undefined, acknowledge: async () => undefined },
  keptKeyOwnerStore: { read: async () => null, write: async () => undefined, forget: async () => undefined },
  setupStore: { read: async () => null, write: async () => undefined },
}));
vi.mock("../src/lib/library", () => ({
  autoFetchLyrics: async () => ({}),
  autoFetchArtistPictures: async () => ({}),
  autoFetchAlbumCovers: async () => ({}),
  onLibraryChanged: () => () => undefined,
  openLibrary: async () => ({ snapshotVersion: 1 }),
  openLibraryCopy: async () => null,
  removeLibrary: async () => undefined,
  saveLibraryEdits: async () => 1,
  autoRefreshCopyChanges: async () => undefined,
  queueAutoLyrics: async () => undefined,
  lyricsPending: { hasWanted: () => false, want: () => undefined, clear: () => undefined },
}));
vi.mock("../src/lib/lookup", () => ({ lookupClient: async () => ({}), stopLookup: () => undefined }));
vi.mock("../src/lib/kept", () => ({ clearKeeping: async () => undefined, keptLibraryLoaded: async () => undefined, startKeeping: async () => undefined }));
vi.mock("../src/lib/libraryOpen", () => ({ libraryOpenOutcome: () => "error" }));
vi.mock("../src/lib/playback", () => ({ stopPlayback: async () => undefined }));
vi.mock("../src/lib/evenVolume", () => ({ loadEvenVolume: async () => undefined }));
vi.mock("../src/lib/profiles", () => ({
  profileStore: { startSession: async () => undefined, endSession: async () => undefined, refresh: async () => undefined },
}));
vi.mock("../src/lib/errorReports", () => ({ getErrorReportsSetting: () => ({ errorReports: false }), setErrorReports: async () => undefined }));
vi.mock("@space/mobile-shell/sibling", () => ({ publishSiblingStatus: async () => undefined }));

import { SessionProvider, useSession, type SessionState } from "../src/state/session";

const ADA: ShellAuthSession = { token: "saved-token", user: { id: "u1", email: "ada@example.com", emailVerified: true } };
const UNPAID = { state: "unpaid", wipeAt: "2027-01-22T00:00:00.000Z" };

let session: SessionState | null = null;
const Probe = () => {
  session = useSession();
  return null;
};

let renderer: ReactTestRenderer | null = null;
const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const mount = async () => {
  await act(async () => {
    renderer = create(
      <SessionProvider>
        <Probe />
      </SessionProvider>
    );
  });
  await flush();
};

const foreground = async () => {
  await act(async () => ctl.appState.forEach((listener) => listener("active")));
  await flush();
};

beforeEach(() => {
  Object.assign(ctl, { stored: null, key: "library-key", access: undefined, meFails: false, reads: [], appState: [] });
  session = null;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("@req ACCT-UNPAID-03[parrot] Parrot's session knows the account's access", () => {
  it("a restored session reads it at start, and again when the app comes back to the front", async () => {
    ctl.stored = ADA;
    ctl.access = UNPAID;
    await mount();
    console.info(SUITE, "start", JSON.stringify({ access: session?.access, reads: ctl.reads }));
    expect(session?.access).toEqual(UNPAID);
    expect(ctl.reads).toEqual(["saved-token"]);
    // The account pays again on the website: the next return to the app hides the notice.
    ctl.access = { state: "paid", wipeAt: null };
    await foreground();
    console.info(SUITE, "foreground", JSON.stringify({ access: session?.access, reads: ctl.reads }));
    expect(session?.access).toEqual({ state: "paid", wipeAt: null });
    // A failed read keeps what was known.
    ctl.meFails = true;
    await foreground();
    expect(session?.access).toEqual({ state: "paid", wipeAt: null });
  });

  it("knows nothing signed out, reads it after a sign-in and forgets it on Sign out", async () => {
    ctl.access = UNPAID;
    await mount();
    expect(session?.access).toBeNull();
    expect(ctl.reads).toEqual([]);
    await act(async () => {
      await session?.signIn(ADA);
    });
    await flush();
    console.info(SUITE, "signed in", JSON.stringify({ access: session?.access, reads: ctl.reads }));
    expect(session?.access).toEqual(UNPAID);
    await act(async () => {
      await session?.signOut();
    });
    await flush();
    console.info(SUITE, "signed out", JSON.stringify({ access: session?.access }));
    expect(session?.access).toBeNull();
  });

  it("an account without an access object (an older server) shows nothing", async () => {
    ctl.stored = ADA;
    await mount();
    expect(ctl.reads).toEqual(["saved-token"]);
    expect(session?.access).toBeNull();
  });
});
