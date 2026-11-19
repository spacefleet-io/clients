/**
 * @test-id BADGER-MOBILE-SETUP-STEP-BAR-BACK-001
 * @level unit
 * @why Chris 2026-11-18: "you can drop the top left one when there's already one at the bottom besides the next one."
 *   Badger's `SetupStepBar` tops its own sign-in and key screens during the phone setup. The key screen has the Back
 *   pill under its card, so its header carries no top "‹ Back"; the sign-in has no pill, so it keeps the top one
 *   (back to the language step).
 *
 * @req UX-SETUP-08[badger-mobile]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_PHONE_SETUP, type PhoneSetupProgress } from "@space/mobile-shell/setup";

const TAG = "[BADGER-MOBILE-SETUP-STEP-BAR-BACK-001]";

const ctl = vi.hoisted(() => ({
  progress: null as PhoneSetupProgress | null,
  saved: [] as PhoneSetupProgress[],
  header: [] as Array<{ step: number; total: number; onBack?: () => void; onLanguage?: unknown }>,
}));

vi.mock("@space/mobile-shell/setup-step", () => ({
  MobileSetupHeader: (props: (typeof ctl.header)[number]) => {
    ctl.header.push(props);
    return null;
  },
}));
vi.mock("@space/mobile-shell/setup-flow", () => ({ PhoneSetupFlow: () => null }));
vi.mock("../src/setup/phoneSetupStore", () => ({
  usePhoneSetup: () => ctl.progress,
  savePhoneSetup: async (next: PhoneSetupProgress) => {
    ctl.saved.push(next);
  },
}));
vi.mock("../src/setup/ProfileSetupQuestion", () => ({ ProfileSetupPhoneStep: () => null }));
vi.mock("../src/setup/TitleLanguageQuestion", () => ({ TitleLanguageStep: () => null }));
vi.mock("../src/lib/titleLanguageQuestion", () => ({ useTitleLanguageQuestion: () => null }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: async () => undefined }));
vi.mock("../src/lib/useAccountLanguageSync", () => ({ useSetupLanguageReconcile: () => undefined }));
vi.mock("../src/lib/appSettings", () => ({ getAppSettings: () => ({ errorReports: false }), updateAppSettings: async () => undefined }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("../src/store/library", () => ({ useLibraryStatus: () => null }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/tv/components/TvSetupStepHeader", () => ({ TvSetupStepHeader: () => null }));

import { SetupStepBar } from "../src/setup/BadgerSetupFlow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mount = async (step: "signIn" | "libraryKey") => {
  ctl.header = [];
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(SetupStepBar, { step }));
  });
  root.unmount();
  const last = ctl.header.at(-1)!;
  console.info(TAG, step, JSON.stringify({ step: last.step, total: last.total, back: Boolean(last.onBack), language: Boolean(last.onLanguage) }));
  return last;
};

describe("Badger's setup header Back (UX-SETUP-08)", () => {
  it("the key screen, with its Back pill under the card, has no top ‹ Back", async () => {
    ctl.progress = { ...INITIAL_PHONE_SETUP, step: "libraryKey" };
    const header = await mount("libraryKey");
    expect(header.onBack).toBeUndefined();
    expect(header.step).toBe(1);
    expect(header.onLanguage).toBeTypeOf("function");
  });

  it("the sign-in, with no pill, keeps the top ‹ Back to the language step", async () => {
    ctl.progress = { ...INITIAL_PHONE_SETUP, step: "signIn" };
    ctl.saved = [];
    const header = await mount("signIn");
    expect(header.onBack).toBeTypeOf("function");
    header.onBack!();
    expect(ctl.saved.map((p) => p.step)).toEqual(["language"]);
  });
});
