// @vitest-environment jsdom
/**
 * @test-id UI-LANGUAGE-PICKERS-001
 * @level unit
 * @why Chris 2026-11-12 (chat): "The language picker menus should be coherent everywhere: (1) they should always have
 *   flags [...] (2) either all the language names are shown in the current language, or they are shown in their
 *   respective language." The shared desktop and web pickers show each language's SVG flag and its own name, in the
 *   shared order.
 */
// @req UX-I18N-10[badger-desktop,badger-web-player,parrot,parrot-web-player,web]
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CLIENT_UI_LANGUAGES, type ClientUiLanguage } from "@space/shared/i18n";
import { LanguageSelect } from "../src/language-select";
import LanguageMenu from "../src/LanguageMenu";
import { Flag } from "../src/flag";
import { FLAG_SVGS, flagDataUri } from "@space/shared/languageFlags";

const LOG = "[UI-LANGUAGE-PICKERS-001]";
const SHARED = CLIENT_UI_LANGUAGES.map((language) => `${language.code}:${language.nativeName}`);

const rowsOf = (rows: Iterable<Element>) =>
  [...rows].map((row) => `${row.querySelector("img[data-flag]")?.getAttribute("data-flag") ?? "-"}:${row.textContent}`);

afterEach(cleanup);

describe("shared language pickers", () => {
  it("lists every language in the shared order, each with its flag and its own name", () => {
    expect(SHARED).toEqual(["en:English", "fr:Français", "nl:Nederlands", "de:Deutsch", "es:Español"]);
  });

  it("LanguageSelect shows the current flag and name, and opens on rows with flags and endonyms", () => {
    const onChange = vi.fn();
    const view = render(
      <LanguageSelect<ClientUiLanguage>
        value="fr"
        onChange={onChange}
        languages={CLIENT_UI_LANGUAGES}
        ariaLabel="Langue"
        testId="lang"
      />,
    );
    const trigger = view.getByTestId("lang");
    console.info(LOG, "trigger", trigger.getAttribute("aria-label"), trigger.querySelector("img[data-flag]")?.getAttribute("data-flag"));
    expect(trigger.getAttribute("aria-label")).toBe("Langue: Français");
    expect(trigger.querySelector("img[data-flag]")?.getAttribute("data-flag")).toBe("fr");

    fireEvent.click(trigger);
    const rows = view.getAllByRole("option");
    console.info(LOG, "rows", rowsOf(rows));
    expect(rowsOf(rows)).toEqual(SHARED);
    expect(rows.map((row) => row.getAttribute("lang"))).toEqual(CLIENT_UI_LANGUAGES.map((language) => language.code));
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(view.getByTestId("lang-option-de"));
    expect(onChange).toHaveBeenCalledWith("de");
    expect(view.queryAllByRole("option")).toHaveLength(0);
  });

  it("LanguageSelect keeps the flag's room for a choice that is not a language, such as Automatic", () => {
    const view = render(
      <LanguageSelect<"auto" | ClientUiLanguage>
        value="auto"
        onChange={() => undefined}
        languages={[{ code: "auto", nativeName: "Automatic" }, ...CLIENT_UI_LANGUAGES]}
        ariaLabel="Metadata"
        testId="meta"
      />,
    );
    const trigger = view.getByTestId("meta");
    expect(trigger.querySelector("img[data-flag]")).toBeNull();
    expect(trigger.querySelector("span.w-6[aria-hidden]")).not.toBeNull();
    fireEvent.click(trigger);
    const rows = view.getAllByRole("option");
    console.info(LOG, "metadata rows", rowsOf(rows));
    expect(rowsOf(rows)).toEqual(["-:Automatic", ...SHARED]);
    expect(rows[0]?.hasAttribute("lang")).toBe(false);
  });

  it("LanguageMenu (header menus and the website pills) draws the same flags and names", () => {
    for (const variant of ["badge", "pills"] as const) {
      const view = render(<LanguageMenu current="en" onSelect={() => undefined} languages={CLIENT_UI_LANGUAGES} variant={variant} />);
      const rows = view.container.querySelectorAll("button[lang]");
      console.info(LOG, variant, rowsOf(rows));
      expect(rowsOf(rows)).toEqual(SHARED);
      cleanup();
    }
  });

  // @bugfix: every row of Parrot's sign-in menu was named "Which language should Parrot use?", and Tab walked
  // through the five rows of the menu while it was hidden.
  it("LanguageMenu names each row by its language, the globe by the question", () => {
    for (const variant of ["badge", "pills"] as const) {
      const view = render(<LanguageMenu current="en" onSelect={() => undefined} languages={CLIENT_UI_LANGUAGES} variant={variant} ariaLabel="Which language should Parrot use?" />);
      const names = [...view.container.querySelectorAll("button[lang]")].map((row) => row.getAttribute("aria-label"));
      console.info(LOG, variant, "row names", names);
      expect(names).toEqual(CLIENT_UI_LANGUAGES.map((language) => language.nativeName));
      if (variant === "badge") expect(view.getByRole("button", { name: "Which language should Parrot use?" }).getAttribute("aria-haspopup")).toBe("true");
      cleanup();
    }
  });

  it("LanguageMenu keeps its closed menu out of the Tab order; the globe opens it for the keyboard and a pick closes it", () => {
    const onSelect = vi.fn();
    const view = render(<LanguageMenu current="en" onSelect={onSelect} languages={CLIENT_UI_LANGUAGES} ariaLabel="Language" />);
    const globe = view.getByRole("button", { name: "Language" });
    const rows = () => [...view.container.querySelectorAll<HTMLButtonElement>("button[lang]")];
    const tabbable = () => rows().filter((row) => row.tabIndex >= 0).length;
    console.info(LOG, "closed", { expanded: globe.getAttribute("aria-expanded"), tabbable: tabbable() });
    expect(globe.getAttribute("aria-expanded")).toBe("false");
    expect(tabbable()).toBe(0);

    fireEvent.click(globe);
    console.info(LOG, "open", { expanded: globe.getAttribute("aria-expanded"), tabbable: tabbable() });
    expect(globe.getAttribute("aria-expanded")).toBe("true");
    expect(tabbable()).toBe(CLIENT_UI_LANGUAGES.length);

    fireEvent.keyDown(rows()[1]!, { key: "Escape" });
    expect(tabbable()).toBe(0);

    fireEvent.click(globe);
    fireEvent.click(rows()[1]!);
    expect(onSelect).toHaveBeenCalledWith("fr");
    expect(globe.getAttribute("aria-expanded")).toBe("false");
    expect(tabbable()).toBe(0);
  });

  it("draws each flag as the Noto emoji artwork in an image, never emoji text", () => {
    // Chris 2026-11-12 (chat): "could you use the flag emojis but as images instead of emojis? they just look better".
    for (const { code } of CLIENT_UI_LANGUAGES) {
      const view = render(<Flag code={code} />);
      const image = view.container.querySelector("img[data-flag]");
      console.info(LOG, "flag", code, image?.getAttribute("class"), FLAG_SVGS[code].length);
      expect(image?.getAttribute("src")).toBe(flagDataUri(code));
      expect(image?.getAttribute("alt")).toBe("");
      expect(image?.getAttribute("class")).toContain("h-4 w-6");
      expect(FLAG_SVGS[code]).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="8 132 984 736">/);
      expect(view.container.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
      cleanup();
    }
    expect(render(<Flag code="xx" />).container.innerHTML).toBe("");
  });
});
