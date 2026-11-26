/**
 * @test-id PARROT-MOBILE-KEY-LOAD-FAILED-001
 * @level unit
 * @bugfix @regression-proof
 * @req UX-KEY-02[parrot]
 * @why Badger desktop 0.1.72's release smoke (2026-11-26) sat on "Loading key…" for 39 and 61 s
 *   while a prod disk stall slowed `GET /library/db/meta`. Parrot's phone and TV key step waits on the same read: a
 *   read that never answered left the mascot loader up, and a failed one showed a bare error over the boxes. Now a
 *   failed or timed-out read shows the shared "could not be loaded" step with Retry, Retry reads again, and no key is
 *   made over the account's.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import type * as SharedApi from "@space/shared/api";
import type { MobileKeyLoadFailedStepProps } from "@space/mobile-shell/key-load-failed-step";
import type { MobileLibraryKeyStepProps } from "@space/mobile-shell/library-key-step";

const phone = vi.hoisted(() => ({
  reads: [] as Array<() => Promise<unknown>>,
  readCount: 0,
  saved: [] as string[],
  signedOut: 0,
}));
const seen = vi.hoisted(() => ({ step: null as null | Record<string, unknown> }));

vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: Record<string, unknown>) => {
    seen.step = props;
    return null;
  },
}));
// The shared step renders for real in mobile-shell; here it is a host element carrying the props Parrot hands it.
vi.mock("@space/mobile-shell/key-load-failed-step", () => ({
  MobileKeyLoadFailedStep: (props: object) => React.createElement("MobileKeyLoadFailedStep", props),
}));
vi.mock("@space/mobile-shell/unpaid-setup-step", () => ({ MobileUnpaidSetupStep: () => null }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr" } }) }));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/mascot-loader", () => ({ MobileMascotLoader: () => null }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
// The real ApiError (the screen's error class reads its status); only the reads are scripted.
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  getLibraryMetaForKeyStep: async () => {
    const next = phone.reads[phone.readCount] ?? phone.reads[phone.reads.length - 1];
    phone.readCount += 1;
    return next();
  },
  resetLibrary: async () => ({ ok: true }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    session: { token: "phone-token" },
    saveLibraryKey: async (key: string) => {
      phone.saved.push(key);
    },
  }),
}));
vi.mock("../src/lib/library", () => ({ claimAccountKey: async () => ({ version: 1 }) }));
vi.mock("../src/state/useSignOut", () => ({
  useSignOut: () => async () => {
    phone.signedOut += 1;
  },
}));
vi.mock("../src/screens/PairingPanel", () => ({ KeyPairingPanel: () => null }));

import { LibraryKeyScreen } from "../src/screens/LibraryKeyScreen";

const SUITE = "[PARROT-MOBILE-KEY-LOAD-FAILED-001]";

let renderer: ReactTestRenderer | null = null;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => void (await Promise.resolve()));
};
const failed = () =>
  (renderer?.root.findAll((node) => (node.type as unknown) === "MobileKeyLoadFailedStep")[0]?.props as MobileKeyLoadFailedStepProps | undefined) ?? null;
const step = () => seen.step as unknown as MobileLibraryKeyStepProps | null;
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}: failed=${failed()?.errorClass ?? "no"} step=${step()?.mode ?? "no"} reads=${phone.readCount} saved=${phone.saved.length}`,
  );

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  seen.step = null;
  phone.reads = [];
  phone.readCount = 0;
  phone.saved.length = 0;
  phone.signedOut = 0;
});

describe("@req UX-KEY-02 Parrot phone and TV: a key step whose meta read fails shows Retry", () => {
  it("a read that runs out of time shows the failed step, no new key; Retry reads again and recovers", async () => {
    phone.reads = [
      async () => {
        throw new ApiError(0, { error: "timeout" });
      },
      async () => ({ keyProbe: "probe", exists: true }),
    ];
    await act(async () => {
      renderer = create(<LibraryKeyScreen />);
    });
    await flush();
    dump("after stall");
    expect(failed()?.errorClass).toBe("timeout");
    expect(failed()?.language).toBe("fr");
    expect(step()).toBeNull();
    expect(phone.saved).toEqual([]);

    const onRetry = failed()!.onRetry;
    await act(async () => onRetry());
    await flush();
    dump("after retry");
    expect(phone.readCount).toBe(2);
    expect(failed()).toBeNull();
    expect(step()?.mode).toBe("enter");
    expect(phone.saved).toEqual([]);
  });

  it("a read that cannot reach the server says so; Back signs out", async () => {
    phone.reads = [
      async () => {
        throw new TypeError("Network request failed");
      },
    ];
    await act(async () => {
      renderer = create(<LibraryKeyScreen />);
    });
    await flush();
    dump("unreachable");
    expect(failed()?.errorClass).toBe("unreachable");
    await act(async () => failed()!.onBack!());
    expect(phone.signedOut).toBe(1);
  });
});
