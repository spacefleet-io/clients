/**
 * @test-id PARROT-MOBILE-SETUP-TOP-INSET-001
 * @level unit
 * @bugfix @regression-proof
 * @req UX-SETUP-02[parrot]
 * @why iPhone simulator run 2026-11-13 04:00 (ParrotUITests screenshot): the setup's step bar drew under the status
 *   bar, "Back" over the clock and "STEP 1 OF 3" under the Wi-Fi and battery icons. Parrot's window pads only the
 *   bottom inset (each signed-in screen pads its own top), and the shared setup step (`MobileSetupStep`) leaves the top
 *   to its parent, so the setup walkthrough and the standalone key screen need the top inset from Parrot. Both are
 *   mounted here with the safe-area view replaced by a stand-in that keeps its edges.
 * @covers apps/parrot/mobile/src/setup/SetupFlow.tsx
 * @covers apps/parrot/mobile/src/screens/LibraryKeyScreen.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode; edges?: string[] }) => <>{children}</>,
}));
vi.mock("@space/mobile-shell/setup-flow", () => ({ PhoneSetupFlow: () => null }));
vi.mock("@space/mobile-shell/library-key-step", () => ({ MobileLibraryKeyStep: () => null }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/mascot-loader", () => ({ MobileMascotLoader: () => null }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("@space/shared/api", () => ({
  getLibraryMetaForKeyStep: async () => ({ exists: false, keyProbe: null }),
  resetLibrary: async () => undefined,
}));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ session: { token: "tok" }, saveLibraryKey: async () => undefined }) }));
vi.mock("../src/state/useSignOut", () => ({ useSignOut: () => async () => undefined }));
vi.mock("../src/screens/PairingPanel", () => ({ KeyPairingPanel: () => null }));
vi.mock("../src/lib/library", () => ({ claimAccountKey: async () => "kept" }));
vi.mock("../src/lib/accountLanguage", () => ({ pickSignedInLanguage: async () => undefined, reconcileAfterSignIn: async () => undefined }));
vi.mock("../src/lib/errorReports", () => ({ getErrorReportsSetting: () => ({ errorReports: false }), setErrorReports: async () => undefined }));
vi.mock("../src/setup/ProfileSetupQuestion", () => ({ ProfileSetupPhoneStep: () => null }));

import { SafeAreaView } from "react-native-safe-area-context";
import { PhoneSetupFlow } from "@space/mobile-shell/setup-flow";
import { MobileLibraryKeyStep } from "@space/mobile-shell/library-key-step";
import { SetupFlow } from "../src/setup/SetupFlow";
import { LibraryKeyScreen } from "../src/screens/LibraryKeyScreen";

const SUITE = "[PARROT-MOBILE-SETUP-TOP-INSET-001]";

let renderer: ReactTestRenderer | null = null;
const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
  // The key screen first reads the account's meta (a loader shows until then).
  for (let i = 0; i < 10; i += 1) await act(async () => void (await Promise.resolve()));
};
/** The edges of every safe-area view above `inner` (outermost first); empty when `inner` sits under none. */
const edgesAbove = (inner: React.ElementType) => {
  const target = renderer!.root.findByType(inner);
  const edges: string[][] = [];
  for (let node = target.parent; node; node = node.parent) {
    if (node.type !== SafeAreaView) continue;
    const props: { edges?: unknown } = node.props;
    edges.unshift(Array.isArray(props.edges) ? props.edges.map(String) : ["top", "right", "bottom", "left"]);
  }
  return edges;
};

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const progress: PhoneSetupProgress = {
  step: "libraryKey",
  done: false,
  pairedKey: false,
  language: "en",
  notifications: null,
  languageReconciled: false,
};

describe("@req UX-SETUP-02 Parrot phone: the setup stands below the status bar", () => {
  it("the setup walkthrough sits under a safe-area view that pads the top", async () => {
    await mount(<SetupFlow progress={progress} save={async () => undefined} />);
    const edges = edgesAbove(PhoneSetupFlow);
    console.info(`${SUITE} setup walkthrough`, JSON.stringify({ edges }));
    expect(edges.some((list) => list.includes("top"))).toBe(true);
  });

  it("the standalone key screen (a key gone after the setup) sits under one too", async () => {
    await mount(<LibraryKeyScreen />);
    const edges = edgesAbove(MobileLibraryKeyStep);
    console.info(`${SUITE} key screen`, JSON.stringify({ edges }));
    expect(edges.some((list) => list.includes("top"))).toBe(true);
  });
});
