import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { creditsFor } from "@space/legal/credits";
import { creditsStoreKey, type CreditsSource, type CreditsStore, type SourceCredits } from "@space/metadata-client/credits";
import { CreditsPanel } from "../src/components/credits-panel";
import { render } from "./utils/render";

const LOGO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 5"></svg>')}`;

const answer = (language: string): SourceCredits => ({
  product: "badger",
  language,
  separator: language === "fr" ? "\u202f: " : ": ",
  entries: [
    { id: "example", name: "Example Source", url: "https://example.org", text: `titles (${language}).`, licence: null, licenceUrl: null, logo: LOGO, notice: "Example notice." },
    { id: "other", name: "Other Source", url: "https://other.example", text: "markers, under CC BY-SA 4.0.", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/", logo: null, notice: null },
  ],
});

const memoryStore = (initial: Record<string, string> = {}): CreditsStore & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

describe("Settings > About credits", () => {
  afterEach(cleanup);

  it.each(["en", "fr", "nl", "de", "es"])("@req UX-SET-02 @req META-SRC-09[badger-desktop,badger-web-player,parrot] lists the service's sources, with a source's logo and notice, in %s", async (language) => {
    const store = memoryStore();
    const load = vi.fn(async (_product: string, lang: string) => answer(lang));
    const view = render(<CreditsPanel language={language} product="badger" source={{ load, store }} />);
    const body = view.getByTestId("settings-credits-body");
    await waitFor(() => expect(body.textContent).toContain("Example Source"));
    console.info(`[credits-panel] ${language}: ${body.querySelectorAll("li").length} sources`);
    expect(load).toHaveBeenCalledWith("badger", language);
    expect(body.querySelector('a[href="https://example.org"]')?.getAttribute("target")).toBe("_blank");
    expect(body.querySelector('[data-testid="credit-logo"]')?.getAttribute("src")).toBe(LOGO);
    expect(body.querySelectorAll('[data-testid="credit-logo"]')).toHaveLength(1);
    expect(body.textContent).toContain("Example notice.");
    // The service picks the typography between a name and its text (French: a narrow no-break space before ":").
    expect(body.querySelector("li")?.textContent).toBe(`Example Source${language === "fr" ? "\u202f: " : ": "}titles (${language}).`);
    expect(body.textContent).toContain(creditsFor(language).heading);
    expect(JSON.parse(store.data[creditsStoreKey("badger", language)] ?? "null")).toEqual(answer(language));
  });

  it("@req META-SRC-09[badger-desktop,badger-web-player,parrot] offline, shows the kept answer, or a neutral line before the app was ever online", async () => {
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    const kept: CreditsSource = { load: offline, store: memoryStore({ [creditsStoreKey("badger", "fr")]: JSON.stringify(answer("fr")) }) };
    const withKept = render(<CreditsPanel language="fr" product="badger" source={kept} />);
    await waitFor(() => expect(withKept.getByTestId("settings-credits-body").textContent).toContain("Example Source"));
    cleanup();
    const never = render(<CreditsPanel language="fr" product="badger" source={{ load: offline, store: memoryStore() }} />);
    await waitFor(() => expect(offline).toHaveBeenCalledTimes(2));
    const line = never.getByTestId("settings-credits-unavailable");
    console.info(`[credits-panel] first offline run: "${line.textContent}"`);
    expect(line.textContent).toBe(creditsFor("fr").unavailable);
    expect(never.getByTestId("settings-credits-body").querySelector("li")).toBeNull();
  });

  // Chris 2026-11-11: the About section in all apps should be a collapsable menu that is closed by default. The
  // attribution stays in the page, unchanged, one click away.
  it.each(["badger", "parrot"] as const)("@req UX-SET-02 sits under an About header, closed by default, opening on click (%s)", async (product) => {
    const view = render(<CreditsPanel language="fr" product={product} source={{ load: async () => answer("fr"), store: null }} />);
    const toggle = view.getByTestId("settings-credits-toggle");
    const body = view.getByTestId("settings-credits-body");
    console.info(`[credits-panel] ${product} closed: expanded=${toggle.getAttribute("aria-expanded")} hidden=${body.hidden}`);
    expect(toggle.textContent).toBe(creditsFor("fr").about);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    await waitFor(() => expect(body.textContent).toContain("Example Source"));
    fireEvent.click(toggle);
    expect(body.hidden).toBe(true);
  });
});
