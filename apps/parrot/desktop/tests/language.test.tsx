// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-LANGUAGE-001
 * @level integration (real App, Library and translator; `window.parrot` mocked, `electron` mocked for the store module)
 * @req UX-I18N-01 UX-I18N-07 UX-I18N-10
 * @why Parrot desktop ships English, French, Dutch, German and Spanish: it starts in the system language when it is one of the
 *   five, every language holds every string with the same placeholders, and the user can switch language at any time
 *   after setup from the Settings page, the screen following at once and the account taking it (UX-I18N-07). The
 *   Settings picker shows each language's flag and its own name, in the shared order (UX-I18N-10).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import { updateRequiredBridgeStub } from "./updateRequiredBridge";
import { PARROT_LANGUAGES, type ParrotLanguage, type ParrotState } from "../src/shared/ipc";
import App from "../src/renderer/src/App";
import { PARROT_STRINGS } from "../src/renderer/src/i18n";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";
import { parrotLanguageFor } from "../src/main/store";

// The store module imports electron's safeStorage; vi.mock is hoisted above the imports.
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-LANGUAGE-001]";

const stateIn = (language: ParrotLanguage): ParrotState => ({
  setup: { step: "errorReports", done: true, language, folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
});

describe("@req UX-I18N-01 Parrot desktop languages", () => {
  it("starts in the system language when Parrot has it, English otherwise", () => {
    const cases: [string, ParrotLanguage][] = [["de-AT", "de"], ["nl-BE", "nl"], ["fr-CA", "fr"], ["en-GB", "en"], ["es-MX", "es"], ["it-IT", "en"], ["", "en"]];
    for (const [locale, want] of cases) {
      console.info(`${SUITE} parrotLanguageFor(${JSON.stringify(locale)}) = ${parrotLanguageFor(locale)}`);
      expect(parrotLanguageFor(locale)).toBe(want);
    }
  });

  it("holds every string in all five languages, with the English placeholders", () => {
    const en = PARROT_STRINGS.en as Record<string, string>;
    const vars = (text: string | undefined) => JSON.stringify((text?.match(/\{\w+\}/g) ?? []).sort());
    for (const language of PARROT_LANGUAGES) {
      const strings = PARROT_STRINGS[language] as Record<string, string>;
      const missing = Object.keys(en).filter((key) => !strings[key]?.trim());
      const placeholderDiffs = Object.keys(en).filter((key) => vars(en[key]) !== vars(strings[key]));
      console.info(`${SUITE} ${language}: missing=${JSON.stringify(missing)} placeholders=${JSON.stringify(placeholderDiffs)}`);
      expect({ language, missing, placeholderDiffs }).toEqual({ language, missing: [], placeholderDiffs: [] });
    }
  });

  describe("switching after setup", () => {
    let container: HTMLDivElement;
    let root: Root;
    let current: ParrotState;
    const parrot = {
      ...streamBridgeStub(),
      ...exportBridgeStub(),
      ...updateRequiredBridgeStub(),
      getState: vi.fn(async () => current),
      saveSetup: vi.fn(async (patch: Partial<ParrotState["setup"]>) => {
        current = { ...current, setup: { ...current.setup, ...patch } };
        return current;
      }),
      saveAccountLanguage: vi.fn(async (_language: ParrotLanguage) => true),
      getLibrary: vi.fn(async () => ({ ok: true, library: { snapshotVersion: 1, artists: [], albums: [], tracks: [] } })),
      getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
      getImportScan: vi.fn(async () => null),
      getLyrics: vi.fn(async () => null),
      onLyricsChanged: vi.fn(() => () => undefined),
      onLibraryChanged: vi.fn(() => () => undefined),
      onLibraryPatch: vi.fn(() => () => undefined),
      onImportStatus: vi.fn(() => () => undefined),
      getCoversWaiting: vi.fn(async () => []),
      onCoversWaiting: vi.fn(() => () => undefined),
      getImportJobs: vi.fn(async () => []),
      onImportJobs: vi.fn(() => () => undefined),
      dismissImportJob: vi.fn(async () => []),
      getBackgroundWork: vi.fn(async () => []),
      onBackgroundWork: vi.fn(() => () => undefined),
      getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
      onKept: vi.fn(() => () => undefined),
    };
    const flush = async () => {
      await act(async () => {
        for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
      });
    };
    const heading = () => document.body.querySelector("h1")?.textContent;
    const dump = (label: string) =>
      console.info(`${SUITE} ${label}: h1=${JSON.stringify(heading())} lang=${document.documentElement.lang} saveSetup=${JSON.stringify(parrot.saveSetup.mock.calls)}`);

    beforeEach(() => {
      vi.clearAllMocks();
      current = stateIn("en");
      (window as unknown as { parrot: typeof parrot }).parrot = parrot;
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.innerHTML = "";
    });

    it("offers the five languages on the Settings page and shows the picked one at once", async () => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<App />));
      await flush();
      dump("mounted");
      // The language lives on the Settings page, behind the gear in the top bar (PAR-NAV-01).
      await act(async () => (document.body.querySelector('[data-testid="nav-settings"]') as HTMLButtonElement).click());
      expect(heading()).toBe(PARROT_STRINGS.en["settings.title"]);

      // UX-I18N-10: a flag dropdown, each row the language's SVG flag and its own name, in the shared order.
      const trigger = () => document.body.querySelector('[data-testid="library-language"]') as HTMLButtonElement;
      await act(async () => trigger().click());
      const rows = [...document.body.querySelectorAll<HTMLElement>('[role="option"][data-testid^="library-language-option-"]')];
      console.info(`${SUITE} settings rows=${JSON.stringify(rows.map((row) => `${row.querySelector("img[data-flag]")?.getAttribute("data-flag")}:${row.textContent}`))}`);
      expect(rows.map((row) => row.getAttribute("lang"))).toEqual([...PARROT_LANGUAGES]);
      expect(rows.map((row) => row.querySelector("img[data-flag]")?.getAttribute("data-flag"))).toEqual([...PARROT_LANGUAGES]);
      expect(rows.map((row) => row.textContent)).toEqual(CLIENT_UI_LANGUAGES.map((l) => l.nativeName));
      await act(async () => trigger().click());

      for (const language of ["de", "nl", "es"] as const) {
        await act(async () => trigger().click());
        await act(async () => (document.body.querySelector(`[data-testid="library-language-option-${language}"]`) as HTMLButtonElement).click());
        await flush();
        dump(`picked ${language}`);
        expect(parrot.saveSetup).toHaveBeenLastCalledWith({ language });
        // The account's one language follows, for every app, profile and email (UX-I18N-07).
        expect(parrot.saveAccountLanguage).toHaveBeenLastCalledWith(language);
        expect(heading()).toBe(PARROT_STRINGS[language]["settings.title"]);
        expect(document.documentElement.lang).toBe(language);
        const name = CLIENT_UI_LANGUAGES.find((l) => l.code === language)!.nativeName;
        expect(trigger().getAttribute("aria-label")).toBe(`${PARROT_STRINGS[language]["library.language"]}: ${name}`);
        expect(trigger().querySelector("img[data-flag]")?.getAttribute("data-flag")).toBe(language);
      }
    });
  });
});
