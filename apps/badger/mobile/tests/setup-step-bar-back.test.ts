/**
 * @test-id BADGER-MOBILE-SETUP-STEP-BAR-BACK-001
 * @level unit
 * @why Chris 2026-11-18: "you can drop the top left one when there's already one at the bottom besides the next one."
 *   Main 2026-11-19: the sign-in's top "‹ Back" goes too. Badger's `SetupStepBar` tops its key screen during the phone
 *   setup, with the count and the language button only (its Back is the pill under the card); the sign-in's Back is
 *   `SignInSetupBack`, the setup's Back pill at the bottom of the screen, back to the language step.
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
  header: [] as Array<{ step: number; total: number; onLanguage?: unknown }>,
  footer: [] as Array<{ onBack: () => void }>,
}));

vi.mock("@space/mobile-shell/setup-step", () => ({
  MobileSetupHeader: (props: (typeof ctl.header)[number]) => {
    ctl.header.push(props);
    return null;
  },
  MobileSetupBackFooter: (props: (typeof ctl.footer)[number]) => {
    ctl.footer.push(props);
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

import { SetupStepBar, SignInSetupBack } from "../src/setup/BadgerSetupFlow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const render = async (element: React.ReactElement) => {
  ctl.header = [];
  ctl.footer = [];
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element);
  });
  root.unmount();
};

describe("Badger's setup Back (UX-SETUP-08)", () => {
  it("the key screen's header is the count and the language button, with no top ‹ Back", async () => {
    ctl.progress = { ...INITIAL_PHONE_SETUP, step: "libraryKey" };
    await render(React.createElement(SetupStepBar));
    const header = ctl.header.at(-1)!;
    console.info(TAG, "key", JSON.stringify({ step: header.step, total: header.total, props: Object.keys(header) }));
    expect(Object.keys(header)).not.toContain("onBack");
    expect(header.step).toBe(1);
    expect(header.onLanguage).toBeTypeOf("function");
  });

  it("the sign-in's Back is the bottom pill, back to the language step, and no header", async () => {
    ctl.progress = { ...INITIAL_PHONE_SETUP, step: "signIn" };
    ctl.saved = [];
    await render(React.createElement(SignInSetupBack));
    console.info(TAG, "signIn", JSON.stringify({ footers: ctl.footer.length, headers: ctl.header.length }));
    expect(ctl.header).toHaveLength(0);
    expect(ctl.footer).toHaveLength(1);
    ctl.footer[0]!.onBack();
    expect(ctl.saved.map((p) => p.step)).toEqual(["language"]);
  });

  it("no Back pill once the setup is done", async () => {
    ctl.progress = { ...INITIAL_PHONE_SETUP, step: "signIn", done: true };
    await render(React.createElement(SignInSetupBack));
    expect(ctl.footer).toHaveLength(0);
  });
});
