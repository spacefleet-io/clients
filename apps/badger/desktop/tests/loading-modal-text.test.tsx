// @vitest-environment jsdom
/**
 * UX-WAIT-01: the loading window shows each line of text once.
 * @req UX-WAIT-01[badger-desktop]
 * @bugfix @regression-proof the subtitle used to render twice (under the title and beside the spinner).
 */
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingModalProvider, useLoadingModal } from "@/components/LoadingModalProvider";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => (key === "app.loading" ? "Loading…" : key) }),
}));

function Opener({ subtitle }: { subtitle?: string }) {
  const { showLoading } = useLoadingModal();
  useEffect(() => {
    showLoading({ title: "Loading library…", subtitle });
  }, [showLoading, subtitle]);
  return null;
}

/** Text a sighted user sees in the window: everything except the screen-reader-only header. */
function visibleText(): string {
  const modal = document.querySelector('[data-testid="loading-modal"]');
  if (!modal) throw new Error("loading modal not rendered");
  const copy = modal.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("loading window text", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("shows the title once and a given subtitle once", () => {
    act(() =>
      root.render(
        <LoadingModalProvider>
          <Opener subtitle="Preparing files" />
        </LoadingModalProvider>,
      ),
    );
    const text = visibleText();
    console.info("[loading-modal-text] visible text with subtitle:", JSON.stringify(text));
    expect(count(text, "Loading library…")).toBe(1);
    expect(count(text, "Preparing files")).toBe(1);
  });

  it("falls back to a single generic line when no subtitle is given", () => {
    act(() =>
      root.render(
        <LoadingModalProvider>
          <Opener />
        </LoadingModalProvider>,
      ),
    );
    const text = visibleText();
    console.info("[loading-modal-text] visible text without subtitle:", JSON.stringify(text));
    expect(count(text, "Loading library…")).toBe(1);
    expect(count(text, "Loading…")).toBe(1);
  });
});
