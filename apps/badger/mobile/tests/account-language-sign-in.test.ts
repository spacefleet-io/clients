/**
 * @test-id MOBILE-ACCOUNT-LANGUAGE-SIGN-IN-001
 * @level unit
 *
 * The account has one language for every app, every profile and its emails (UX-I18N-07). `useAccountLanguageSync`,
 * mounted once in the navigator on phone and TV:
 *  - asks "Which language do you want?" once right after a sign-in or pairing (a session appearing while the app
 *    ran signed out) when the account's language differs from the one chosen before signing in;
 *  - never asks for a session restored at start: there the account's language from `/auth/me` simply wins;
 *  - ignores profiles: there is no "several profiles" exception any more;
 *  - leaves a sign-in made during the phone's first setup to the setup (UX-SETUP-08): the setup's `reconcileLanguage`
 *    (`useSetupLanguageReconcile`) asks once right after it, and the hook neither asks nor syncs until it has. The TV
 *    never uses the phone setup.
 *
 * Mounts the real hooks with react-test-renderer over the real phone setup store; the auth state, `/auth/me`,
 * `PATCH /account/settings` and the prompt are stand-ins.
 *
 * @req UX-I18N-07[badger-mobile,badger-tv]
 * @req UX-SETUP-08[badger-mobile]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import type * as MobileI18n from "@space/mobile-shell/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage } from "./harness";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { INITIAL_PHONE_SETUP, type PhoneSetupProgress } from "@space/mobile-shell/setup";
import { useAccountLanguageSync, useSetupLanguageReconcile } from "../src/lib/useAccountLanguageSync";
import * as uiLanguage from "../src/lib/uiLanguage";
import { __resetPhoneSetupForTests, savePhoneSetup } from "../src/setup/phoneSetupStore";

const TAG = "[account-language-sign-in]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} phase=${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakeStorage = createFakeAsyncStorage();

type FakeUser = { id: string; email: string; displayName: string; uiLanguage: string | null; preferences?: Record<string, unknown> };

const ctl = vi.hoisted(() => ({
  auth: { token: null as string | null, user: null as unknown, loading: true },
  account: null as string | null,
  saves: [] as string[],
  asked: [] as Array<{ device: string; account: string }>,
  answer: "account" as "device" | "account",
  tv: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  I18nManager: { getConstants: () => ({ localeIdentifier: "en_US" }) },
  Settings: { get: () => ["en-US"] },
}));
vi.mock("../src/tv/lib/tvRuntime", () => ({
  get IS_TV() {
    return ctl.tv;
  },
}));
// react-i18next resolves another React copy under vitest; the hook only reads the current language from it.
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof MobileI18n>();
  return { ...actual, useTranslation: () => ({ i18n: { language: actual.getCurrentLanguage() } }) };
});
vi.mock("@space/mobile-shell/account-language-prompt", () => ({
  askAccountLanguage: async (options: { device: string; account: string }) => {
    ctl.asked.push(options);
    return options[ctl.answer];
  },
}));
vi.mock("../src/store/auth", () => ({
  useAuth: () => ({
    ...ctl.auth,
    setUser: (user: unknown) => {
      ctl.auth = { ...ctl.auth, user };
    },
  }),
}));
vi.mock("@space/shared/api", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  getMe: async () => ({ user: { id: "u1", uiLanguage: ctl.account } }),
  updateSettings: async (_token: string, patch: { preferences: { uiLanguage: string } }) => {
    ctl.saves.push(patch.preferences.uiLanguage);
    ctl.account = patch.preferences.uiLanguage;
    return {};
  },
}));

const userWith = (language: string | null): FakeUser => ({ id: "u1", email: "u1@example.com", displayName: "U1", uiLanguage: language });

/** The setup's `reconcileLanguage`, as `BadgerSetupFlow` passes it to `PhoneSetupFlow`. */
let setupReconcile: (() => Promise<void>) | null = null;

const Probe = () => {
  useAccountLanguageSync();
  setupReconcile = useSetupLanguageReconcile();
  return null;
};

const setupAt = (progress: Partial<PhoneSetupProgress>) => savePhoneSetup({ ...INITIAL_PHONE_SETUP, ...progress });

let renderer: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const rerender = async () => {
  await act(async () => renderer?.update(React.createElement(Probe)));
  await flush();
};

beforeEach(async () => {
  fakeStorage._backing.clear();
  ctl.saves = [];
  ctl.asked = [];
  ctl.answer = "account";
  ctl.tv = false;
  setupReconcile = null;
  // A phone whose first setup is finished, unless a test opens it.
  __resetPhoneSetupForTests();
  await setupAt({ step: "errorReports", language: "en", done: true, languageReconciled: true });
  await uiLanguage.ensureI18n();
  await uiLanguage.chooseUiLanguage("en", { pushToAccount: false });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  await uiLanguage.forgetAccountLanguage();
});

describe("account language at sign-in (UX-I18N-07)", () => {
  it("@req UX-I18N-07 a sign-in on a device in another language asks once, and the account's pick is shown", async () => {
    ctl.auth = { token: null, user: null, loading: false };
    ctl.account = "fr";
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await flush();
    log("signed-out", { language: getCurrentLanguage() });

    ctl.auth = { token: "token", user: userWith("fr"), loading: false };
    await rerender();
    await rerender();
    log("signed-in", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage() });
    expect(ctl.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(ctl.saves, "the account keeps its own language").toEqual([]);
    expect(getCurrentLanguage()).toBe("fr");
  });

  it("@req UX-I18N-07 picking this device's language at sign-in saves it on the account", async () => {
    ctl.auth = { token: null, user: null, loading: false };
    ctl.account = "fr";
    ctl.answer = "device";
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await flush();
    ctl.auth = { token: "token", user: userWith("fr"), loading: false };
    await rerender();
    await rerender();
    log("signed-in-keep-device", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage(), user: ctl.auth.user });
    expect(ctl.asked).toHaveLength(1);
    expect(ctl.saves).toEqual(["en"]);
    expect(getCurrentLanguage()).toBe("en");
    expect((ctl.auth.user as FakeUser).uiLanguage, "the in-memory user follows the account").toBe("en");
  });

  it("@req UX-I18N-07 a session restored at start never asks: the account's language from /auth/me wins", async () => {
    ctl.auth = { token: "token", user: userWith("de"), loading: true };
    ctl.account = "de";
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await flush();
    ctl.auth = { ...ctl.auth, loading: false };
    await rerender();
    log("restored", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage() });
    expect(ctl.asked).toEqual([]);
    expect(ctl.saves).toEqual([]);
    expect(getCurrentLanguage()).toBe("de");

    // Another device changed the account's language: the next /auth/me brings it here.
    ctl.account = "nl";
    ctl.auth = { ...ctl.auth, user: userWith("nl") };
    await rerender();
    log("changed-elsewhere", { language: getCurrentLanguage() });
    expect(getCurrentLanguage()).toBe("nl");
    expect(ctl.asked).toEqual([]);
  });

  it("@req UX-I18N-07 a language picked while signed in reaches the account", async () => {
    ctl.auth = { token: "token", user: userWith("en"), loading: false };
    ctl.account = "en";
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await flush();
    await uiLanguage.chooseUiLanguage("es", { pushToAccount: true });
    await rerender();
    log("picked", { saves: ctl.saves, language: getCurrentLanguage() });
    expect(ctl.saves).toEqual(["es"]);
    expect(ctl.account).toBe("es");
    expect(getCurrentLanguage()).toBe("es");
  });
});

describe("account language at a sign-in during the phone's first setup (UX-SETUP-08)", () => {
  const signInDuringSetup = async () => {
    ctl.auth = { token: null, user: null, loading: false };
    ctl.account = "fr";
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await flush();
    ctl.auth = { token: "token", user: userWith("fr"), loading: false };
    await rerender();
    await rerender();
  };

  it("@req UX-SETUP-08 the session check leaves the question to the setup, which asks once right after the sign-in", async () => {
    // Step 0 picked English; the sign-in screen is next.
    await setupAt({ step: "signIn", language: "en" });
    await signInDuringSetup();
    log("setup-signed-in", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage() });
    expect(ctl.asked, "the session check does not ask over the setup").toEqual([]);
    expect(ctl.saves).toEqual([]);
    expect(getCurrentLanguage(), "the account's language is not applied over the step-0 pick").toBe("en");

    // PhoneSetupFlow: `reconcileLanguage`, then `languageReconciled: true`.
    await act(async () => {
      await setupReconcile!();
    });
    await act(async () => {
      await setupAt({ step: "libraryKey", language: "en", languageReconciled: true });
    });
    await rerender();
    await rerender();
    log("setup-reconciled", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage(), user: ctl.auth.user });
    expect(ctl.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(getCurrentLanguage()).toBe("fr");
    expect(ctl.saves).toEqual([]);
  });

  it("@req UX-SETUP-08 picking the step-0 language in the setup's question saves it on the account", async () => {
    ctl.answer = "device";
    await setupAt({ step: "signIn", language: "en" });
    await signInDuringSetup();
    await act(async () => {
      await setupReconcile!();
    });
    await act(async () => {
      await setupAt({ step: "libraryKey", language: "en", languageReconciled: true });
    });
    await rerender();
    log("setup-keep-device", { asked: ctl.asked, saves: ctl.saves, language: getCurrentLanguage() });
    expect(ctl.asked).toHaveLength(1);
    expect(ctl.saves).toEqual(["en"]);
    expect(getCurrentLanguage()).toBe("en");
    expect((ctl.auth.user as FakeUser).uiLanguage).toBe("en");
  });

  it("@req UX-SETUP-08 once the setup is done, a later sign-in asks from the session check", async () => {
    // beforeEach: the setup is finished.
    await signInDuringSetup();
    log("after-setup-signed-in", { asked: ctl.asked, language: getCurrentLanguage() });
    expect(ctl.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(getCurrentLanguage()).toBe("fr");
  });

  it("@req UX-I18N-07 the TV never uses the phone setup: its sign-in asks from the session check", async () => {
    ctl.tv = true;
    await setupAt({ step: "signIn", language: "en" });
    await signInDuringSetup();
    log("tv-signed-in", { asked: ctl.asked, language: getCurrentLanguage() });
    expect(ctl.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(getCurrentLanguage()).toBe("fr");
  });
});
