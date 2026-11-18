/**
 * @test-id PARROT-MOBILE-SETUP-ACCOUNT-LANGUAGE-001
 * @level unit
 * @req UX-SETUP-08[parrot]
 * @req UX-I18N-07[parrot]
 * @why Chris 2026-11-11: during the phone's first setup, "Which language do you want?" comes from the setup, right after
 *   the sign-in and before its first numbered step, not from the sign-in itself; until then the account's language is
 *   not shown over the one picked at step 0. Once the setup is done (or on a phone set up before it existed), a fresh
 *   sign-in asks as before. The real SessionProvider and SetupFlow are mounted; the stores, the library, the API and
 *   the prompt are stand-ins, and `PhoneSetupFlow` hands back the `reconcileLanguage` it was given.
 * @covers apps/parrot/mobile/src/state/session.tsx
 * @covers apps/parrot/mobile/src/setup/SetupFlow.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import type { ShellAuthSession } from "@space/mobile-shell/services/auth";

const phone = vi.hoisted(() => ({
  shown: "en",
  account: "fr" as string | null,
  pick: "fr",
  asked: [] as unknown[],
  saved: [] as unknown[],
  applied: [] as string[],
  setup: null as unknown,
  appState: [] as Array<(status: string) => void>,
  reconcileLanguage: null as (() => Promise<void>) | null,
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      phone.appState.push(listener);
      return { remove: () => void (phone.appState = phone.appState.filter((other) => other !== listener)) };
    },
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => phone.shown,
  useTranslation: () => ({ i18n: { language: phone.shown }, t: (key: string) => key }),
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/mobile-shell/account-language-prompt", () => ({
  askAccountLanguage: async (choice: unknown) => {
    phone.asked.push(choice);
    return phone.pick;
  },
}));
vi.mock("@space/shared/api", () => ({
  logout: async () => undefined,
  // The kept-key check (UX-KEY-01) gets no answer here: no verdict, so the key stays.
  getLibraryMeta: async () => {
    throw new Error("offline");
  },
  getMe: async () => ({ user: { id: "u1", email: "a@b.c", uiLanguage: phone.account ?? undefined, preferences: {} } }),
  updateSettings: async (token: string, input: unknown) => {
    phone.saved.push({ token, input });
    return { user: {} };
  },
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("../src/lib/i18n", () => ({
  setParrotLanguage: async (code: string) => {
    phone.applied.push(code);
    phone.shown = code;
  },
}));
vi.mock("../src/lib/stores", () => ({
  sessionStore: { read: async () => null, write: async () => undefined },
  libraryKeyStore: { get: async () => null, set: async () => undefined, clear: async () => undefined, acknowledge: async () => undefined },
  keptKeyOwnerStore: { read: async () => null, write: async () => undefined, forget: async () => undefined },
  setupStore: { read: async () => phone.setup, write: async (next: unknown) => void (phone.setup = next) },
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
}));
vi.mock("../src/lib/lookup", () => ({ lookupClient: async () => ({}), stopLookup: () => undefined }));
vi.mock("../src/lib/kept", () => ({ clearKeeping: async () => undefined, keptLibraryLoaded: async () => undefined, startKeeping: async () => undefined }));
vi.mock("../src/lib/libraryOpen", () => ({ libraryOpenOutcome: () => "error" }));
vi.mock("../src/lib/playback", () => ({ stopPlayback: async () => undefined }));
vi.mock("../src/lib/evenVolume", () => ({ loadEvenVolume: async () => undefined }));
vi.mock("../src/lib/profiles", () => ({
  profileStore: { startSession: async () => undefined, endSession: async () => undefined, refresh: async () => undefined },
}));
// SetupFlow's own screens: only the props it hands the shared walkthrough matter here.
vi.mock("@space/mobile-shell/setup-flow", () => ({
  PhoneSetupFlow: (props: { reconcileLanguage?: () => Promise<void> }) => {
    phone.reconcileLanguage = props.reconcileLanguage ?? null;
    return null;
  },
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileSetupStep: () => null }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("../src/lib/errorReports", () => ({ getErrorReportsSetting: () => ({ errorReports: false }), setErrorReports: async () => undefined }));
vi.mock("../src/screens/LibraryKeyScreen", () => ({ ParrotLibraryKeyStep: () => null }));
vi.mock("../src/state/useSignOut", () => ({ useSignOut: () => async () => undefined }));

import { SessionProvider, useSession } from "../src/state/session";
import { SetupFlow } from "../src/setup/SetupFlow";

const SUITE = "[PARROT-MOBILE-SETUP-ACCOUNT-LANGUAGE-001]";
const dump = (label: string) =>
  console.info(`${SUITE} ${label}`, JSON.stringify({ shown: phone.shown, asked: phone.asked, saved: phone.saved, applied: phone.applied, setup: phone.setup }));

const progress = (answers: Partial<PhoneSetupProgress>): PhoneSetupProgress => ({
  step: "language",
  done: false,
  pairedKey: false,
  language: null,
  notifications: null,
  languageReconciled: false,
  ...answers,
});

let signInNow: ((next: ShellAuthSession) => Promise<void>) | null = null;
const Probe = () => {
  signInNow = useSession().signIn;
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
        <SetupFlow progress={progress({ step: "libraryKey", language: "en" })} save={async () => undefined} />
      </SessionProvider>
    );
  });
  await flush();
};

const signIn = async () => {
  await act(async () => {
    await signInNow!({ token: "tok", user: { id: "u1", email: "a@b.c", emailVerified: true } });
  });
  await flush();
};

const comeBackToTheApp = async () => {
  await act(async () => phone.appState.forEach((listener) => listener("active")));
  await flush();
};

beforeEach(() => {
  Object.assign(phone, { shown: "en", account: "fr", pick: "fr", asked: [], saved: [], applied: [], setup: null, appState: [], reconcileLanguage: null });
  signInNow = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("@req UX-SETUP-08 Parrot phone: the sign-in's language question during the first setup", () => {
  it("the sign-in leaves the question to the setup, which asks once right after it", async () => {
    // Step 0 picked English; the sign-in is next.
    phone.setup = progress({ step: "signIn", language: "en" });
    await mount();
    await signIn();
    await comeBackToTheApp();
    dump("signed in during setup");
    expect(phone.asked, "the sign-in does not ask over the setup").toEqual([]);
    expect(phone.applied, "the account's language is not shown over the step-0 pick").toEqual([]);

    // PhoneSetupFlow: `reconcileLanguage`, then `languageReconciled: true`.
    await act(async () => {
      await phone.reconcileLanguage!();
    });
    phone.setup = progress({ step: "libraryKey", language: "en", languageReconciled: true });
    await comeBackToTheApp();
    dump("setup reconciled");
    expect(phone.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(phone.applied).toEqual(["fr"]);
    expect(phone.saved).toEqual([]);
  });

  it("once the setup is done, a fresh sign-in asks itself", async () => {
    phone.setup = progress({ step: "errorReports", language: "en", done: true, languageReconciled: true });
    await mount();
    await signIn();
    dump("signed in after setup");
    expect(phone.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(phone.applied).toEqual(["fr"]);
  });

  it("a phone set up before the walkthrough existed (no setup answer) asks at the sign-in", async () => {
    phone.setup = progress({});
    await mount();
    await signIn();
    dump("signed in, no setup");
    expect(phone.asked).toEqual([{ device: "en", account: "fr" }]);
  });
});
