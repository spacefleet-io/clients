// @vitest-environment jsdom
/**
 * UX-SETUP-08 (Chris 2026-11-11): a new computer asks "Choose your language" (step 0, no step count) before the sign-in,
 * as a scrolling list (UX-LIST-01) with the computer's language preselected. Picking a language shows it at once; Next
 * opens the sign-in. A computer that answered (or was signed in before) opens straight on the sign-in.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/assets/mascot.webp", () => ({ default: "mascot.webp" }));
const picked = vi.hoisted(() => ({ pickUiLanguage: vi.fn() }));
vi.mock("../src/renderer/src/lib/accountUiLanguage", () => picked);
vi.mock("../src/renderer/src/lib/config", () => ({ loadClientConfig: () => ({ uiLanguage: "fr" }) }));

import LanguageFirstGate from "../src/renderer/src/components/LanguageFirstGate";
import { isSetupLanguageChosen, markSetupLanguageChosen } from "../src/renderer/src/lib/setupLanguage";

let host: HTMLDivElement;
let root: Root;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const mount = async () => {
  await act(async () => {
    root.render(
      <LanguageFirstGate>
        <p data-testid="sign-in" />
      </LanguageFirstGate>,
    );
  });
};

beforeEach(() => {
  window.localStorage.clear();
  picked.pickUiLanguage.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("language before sign-in", () => {
  it("@req UX-SETUP-08[badger-desktop] a new computer opens on the language, step 0 with no count, then the sign-in", async () => {
    await mount();
    expect(q("sign-in")).toBeNull();
    expect(q("setup-language")).not.toBeNull();
    expect(q("setup-step-bar")).toBeNull();
    expect(q("setup-language-list")?.className).toContain("max-h-64");
    // The computer's language is preselected.
    expect(q("setup-language-fr")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => q("setup-language-de")?.click());
    expect(picked.pickUiLanguage).toHaveBeenLastCalledWith("de");
    await act(async () => q("setup-language-next")?.click());
    expect(q("sign-in")).not.toBeNull();
    expect(isSetupLanguageChosen()).toBe(true);
  });

  it("a computer that already chose (or was signed in) opens straight on the sign-in", async () => {
    markSetupLanguageChosen();
    await mount();
    expect(q("setup-language")).toBeNull();
    expect(q("sign-in")).not.toBeNull();
  });
});
