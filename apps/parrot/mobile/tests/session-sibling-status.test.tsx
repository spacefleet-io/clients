/**
 * @test-id PARROT-MOBILE-SIBLING-STATUS-001
 * @level unit
 * @req ACCT-PAIR-07[parrot]
 * @why Badger on the same phone offers "Continue with your Parrot account" only while Parrot can sign it in: a session
 *   AND the library key (the approval seals that key to Badger). Parrot tells the native status store which account
 *   it holds ({email, userId}, never the token or the key), and clears it on Sign out.
 *
 * Mounts the real SessionProvider; the stores, the API and the native status store are stand-ins.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellAuthSession } from "@space/mobile-shell/services/auth";

const SUITE = "[parrot-sibling-status]";

const ctl = vi.hoisted(() => ({
  stored: null as ShellAuthSession | null,
  key: null as string | null,
  published: [] as unknown[],
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
  getMe: async () => ({ user: { id: "u1", email: "a@b.c", uiLanguage: undefined, preferences: {} } }),
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
vi.mock("@space/mobile-shell/sibling", () => ({
  publishSiblingStatus: async (status: unknown) => {
    ctl.published.push(status);
  },
}));

import { SessionProvider, useSession, type SessionState } from "../src/state/session";

const ADA: ShellAuthSession = { token: "saved-token", user: { id: "u1", email: "ada@example.com", emailVerified: true } };

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

beforeEach(() => {
  Object.assign(ctl, { stored: null, key: null, published: [], appState: [] });
  session = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("Parrot tells the sister app which account it can sign in", () => {
  it("publishes the saved session's account once the library key is there, without token or key", async () => {
    ctl.stored = ADA;
    ctl.key = "library-key";
    await mount();
    console.info(SUITE, "saved session", ctl.published);
    expect(ctl.published.at(-1)).toEqual({ email: "ada@example.com", userId: "u1" });
    expect(JSON.stringify(ctl.published)).not.toMatch(/saved-token|library-key/);
  });

  it("offers nothing while the library key is still missing", async () => {
    ctl.stored = ADA;
    await mount();
    console.info(SUITE, "no key", ctl.published);
    expect(ctl.published.at(-1) ?? null).toBeNull();
  });

  it("publishes after a sign-in and clears on Sign out", async () => {
    ctl.key = "library-key";
    await mount();
    expect(ctl.published.at(-1) ?? null).toBeNull();
    await act(async () => {
      await session?.signIn(ADA);
    });
    await flush();
    expect(ctl.published.at(-1)).toEqual({ email: "ada@example.com", userId: "u1" });
    await act(async () => {
      await session?.signOut();
    });
    await flush();
    console.info(SUITE, "after sign out", ctl.published);
    expect(ctl.published.at(-1)).toBeNull();
  });
});
