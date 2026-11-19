// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-LAUNCHING-MASCOT-001
 * @level unit
 * @req UX-WAIT-02[badger-desktop]
 * @why Chris 2026-11-18: the small "Launching player…" window shown when playback starts gets the hovering badger of
 *   the launch screens in place of the spinner, straight on the see-through backdrop (no dark card); its text and the
 *   download progress bar stay. Main 2026-11-19 (PR #2993 review): with no card, the close button sits right of the
 *   title rather than alone in an empty corner, and the window's words use the typographic ellipsis "…" in every language.
 */
import React, { act, useEffect } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingModalProvider, useLoadingModal } from "@/components/LoadingModalProvider";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const LOG = "[BADGER-DESKTOP-LAUNCHING-MASCOT-001]";

function Opener({ subtitle }: { subtitle?: string }) {
  const { showLoading } = useLoadingModal();
  useEffect(() => {
    showLoading({ title: "Launching player…", subtitle });
  }, [showLoading, subtitle]);
  return null;
}

describe("the launching window", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
    Object.defineProperty(Element.prototype, "animate", { value: () => ({ cancel: () => {} }), configurable: true, writable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it.each([undefined, "42%"])("shows the hovering badger above the text, with no spinner and no card (subtitle %s)", (subtitle) => {
    act(() =>
      root.render(
        <LoadingModalProvider>
          <Opener subtitle={subtitle} />
        </LoadingModalProvider>,
      ),
    );
    const modal = document.querySelector<HTMLElement>('[data-testid="loading-modal"]')!;
    console.info(LOG, subtitle ?? "no subtitle", modal.innerHTML.length, "chars");
    const mascot = modal.querySelector('[data-testid="mascot-loader-badger"]');
    expect(mascot).not.toBeNull();
    expect(modal.querySelector(".animate-spin")).toBeNull();
    expect(modal.querySelector(".rounded-2xl")).toBeNull();
    const title = [...modal.querySelectorAll("div")].find((el) => el.textContent === "Launching player…")!;
    expect(mascot!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    if (subtitle) expect(modal.textContent).toContain("42%");
  });

  it("puts the close button right beside the title, not in an empty corner", () => {
    act(() =>
      root.render(
        <LoadingModalProvider>
          <Opener />
        </LoadingModalProvider>,
      ),
    );
    const modal = document.querySelector<HTMLElement>('[data-testid="loading-modal"]')!;
    const closes = [...modal.querySelectorAll("button")];
    console.info(LOG, "close buttons", closes.map((b) => b.dataset.testid ?? b.className));
    expect(closes).toHaveLength(1);
    const close = closes[0]!;
    expect(close.dataset.testid).toBe("launching-loader-close");
    expect(close.className).toContain("left-full");
    expect(close.parentElement!.firstElementChild!.textContent).toBe("Launching player…");
    expect(close.textContent).toBe("Close");
  });

  it("uses the typographic ellipsis in every language for the window's words", () => {
    for (const lang of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(join(import.meta.dirname, `../src/renderer/src/i18n/${lang}.json`), "utf8"));
      for (const text of [strings.player.launching, strings.app.loading, strings.player.preparingPlayback] as string[]) {
        console.info(LOG, lang, JSON.stringify(text));
        expect(text, `${lang}: ${text}`).not.toContain("...");
      }
      expect(strings.player.launching).toMatch(/…$/);
      expect(strings.app.loading).toMatch(/…$/);
    }
  });
});
