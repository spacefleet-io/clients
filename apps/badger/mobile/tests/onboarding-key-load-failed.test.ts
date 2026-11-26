/**
 * @test-id BADGER-MOBILE-KEY-LOAD-FAILED-001
 * @level unit
 * @bugfix @regression-proof
 * @req UX-KEY-02[badger-mobile,badger-tv]
 * @why Badger desktop 0.1.72's release smoke (2026-11-26) sat on "Loading key…" for 39 and 61 s
 *   while a prod disk stall slowed `GET /library/db/meta`. The phone and TV key step (one screen) waited on the same
 *   read: a stalled read left the spinner up, and a failed one fell through to the enter form as if the account had a
 *   key. Now a failed or timed-out read shows the shared "could not be loaded" step with Retry, Retry reads again,
 *   and a key kept on the device stays.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import type * as SharedApi from "@space/shared/api";
import { OnboardingKeyScreen } from "../src/screens/OnboardingKeyScreen";

const SUITE = "[BADGER-MOBILE-KEY-LOAD-FAILED-001]";

const ctl = vi.hoisted(() => ({
  reads: [] as Array<() => Promise<unknown>>,
  readCount: 0,
  storedKey: null as string | null,
  stored: [] as string[],
  cleared: [] as string[],
  signedOut: 0,
}));

vi.mock("react-native", async () => ({
  ...(await import("./setup/reactNativeMock")).reactNativeBase(),
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: { overlay?: React.ReactNode }) => React.createElement("MobileLibraryKeyStep", props, props.overlay),
}));
vi.mock("@space/mobile-shell/key-load-failed-step", () => ({
  MobileKeyLoadFailedStep: (props: object) => React.createElement("MobileKeyLoadFailedStep", props),
}));
vi.mock("@space/mobile-shell/keyboard", () => ({
  KeyboardAvoidingForm: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/components", () => ({
  MobilePhoneSignInCard: "MobilePhoneSignInCard",
  MobileScreen: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: () => ({ info: () => undefined, error: () => undefined, warn: () => undefined }),
}));
vi.mock("../src/theme/theme", () => ({
  theme: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token-1" }) }));
vi.mock("../src/store/library", () => ({
  useLibrary: () => ({ acknowledgeKey: async () => undefined, error: null }),
}));
vi.mock("../src/lib/useSignOut", () => ({
  useSignOut: () => async () => {
    ctl.signedOut += 1;
  },
}));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SetupStepBar: () => null }));
vi.mock("../src/screens/KeyFromAnotherDevice", () => ({ KeyFromAnotherDevice: () => null }));
vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: async () => ctl.storedKey,
  setStoredLibraryKey: async (key: string) => {
    ctl.stored.push(key);
  },
  clearLibraryKey: async () => {
    ctl.cleared.push("key");
  },
}));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: async () => new Uint8Array(32) }));
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: { open: async () => ({ close: async () => undefined }), clearLocalCache: async () => undefined },
}));
// The real ApiError (the screen's error class reads its status); only the reads are scripted.
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  getLibraryMetaForKeyStep: async () => {
    const next = ctl.reads[ctl.readCount] ?? ctl.reads[ctl.reads.length - 1];
    ctl.readCount += 1;
    return next();
  },
  resetLibrary: async () => ({ ok: true }),
}));

let tree: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};
const mount = async () => {
  await act(async () => {
    tree = create(React.createElement(OnboardingKeyScreen));
  });
  await flush();
  return tree!;
};
const failedStep = (t: ReactTestRenderer) => t.root.findAll((node) => (node.type as unknown) === "MobileKeyLoadFailedStep")[0];
const keyStep = (t: ReactTestRenderer) => t.root.findAll((node) => (node.type as unknown) === "MobileLibraryKeyStep")[0];
const dump = (label: string, t: ReactTestRenderer) =>
  console.info(
    `${SUITE} ${label}: failed=${failedStep(t)?.props.errorClass ?? "no"} keyStep=${keyStep(t) ? keyStep(t).props.mode ?? "yes" : "no"} reads=${ctl.readCount} stored=${ctl.stored.length} cleared=${ctl.cleared.length}`,
  );

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  ctl.reads = [];
  ctl.readCount = 0;
  ctl.storedKey = null;
  ctl.stored.length = 0;
  ctl.cleared.length = 0;
  ctl.signedOut = 0;
});

describe("@req UX-KEY-02 Badger phone and TV: a key step whose meta read fails shows Retry", () => {
  it("a read that runs out of time shows the failed step, no new words; Retry reads again and recovers", async () => {
    ctl.reads = [
      async () => {
        throw new ApiError(0, { error: "timeout" });
      },
      async () => ({ exists: true, bootstrapRequired: false, keyProbe: "probe" }),
    ];
    const t = await mount();
    dump("after stall", t);
    expect(failedStep(t)?.props.errorClass).toBe("timeout");
    expect(failedStep(t)?.props.language).toBe("en");
    expect(keyStep(t)).toBeUndefined();
    expect(ctl.stored).toEqual([]);

    await act(async () => failedStep(t).props.onRetry());
    await flush();
    dump("after retry", t);
    expect(ctl.readCount).toBe(2);
    expect(failedStep(t)).toBeUndefined();
    expect(keyStep(t)).toBeDefined();
  });

  it("with a key kept on the device, a failed read keeps it and shows the failed step", async () => {
    ctl.storedKey = "a2VwdA==";
    ctl.reads = [
      async () => {
        throw new TypeError("Network request failed");
      },
    ];
    const t = await mount();
    dump("stored key, unreachable", t);
    expect(failedStep(t)?.props.errorClass).toBe("unreachable");
    expect(ctl.cleared).toEqual([]);
    expect(ctl.stored).toEqual([]);
    expect(ctl.signedOut).toBe(0);
  });
});
