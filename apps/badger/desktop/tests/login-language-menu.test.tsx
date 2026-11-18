// @vitest-environment jsdom
/**
 * The language picker on Badger desktop's first screen (the sign-in page) offers every language the app ships
 * (`CLIENT_UI_LANGUAGES`, UX-I18N-01), not only English and French, each as its SVG flag and its own name (UX-I18N-10).
 *
 * @req UX-I18N-01[badger-desktop] UX-I18N-10[badger-desktop]
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_UI_LANGUAGES } from "@space/shared";
import Login from "../src/renderer/src/pages/Login";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ login: vi.fn(), systemIssue: null, setSession: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.assign(window, { sf: { pairing: {} } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "sf");
});

describe("Badger desktop first-screen language picker", () => {
  it("lists every client language", () => {
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/login"]}>
          <Login />
        </MemoryRouter>,
      ),
    );
    // The globe button carries the menu's name; each row is named by its own language (UX-I18N-10, ux.md "Keyboard").
    const globe = container.querySelector<HTMLButtonElement>('button[aria-label="settings.ui.language"][aria-controls]');
    expect(globe).not.toBeNull();
    const menu = document.getElementById(globe!.getAttribute("aria-controls")!);
    const rows = [...(menu?.querySelectorAll<HTMLButtonElement>("button[lang]") ?? [])];
    const shown = rows.map((row) => `${row.querySelector("img[data-flag]")?.getAttribute("data-flag")}:${row.textContent?.trim()}:${row.getAttribute("aria-label")}`);
    console.info(`[login-language-menu] shown=${shown.join(",")}`);
    expect(shown).toEqual(CLIENT_UI_LANGUAGES.map((language) => `${language.code}:${language.nativeName}:${language.nativeName}`));
  });
});
