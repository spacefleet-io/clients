// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryLoading, MascotLoading } from "../src/library-loading";

const LOG = "[UI-LIBRARY-LOADING-001]";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stubMotion = () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
  Object.defineProperty(Element.prototype, "animate", { value: vi.fn(() => ({ cancel: vi.fn() })), configurable: true, writable: true });
};

// @req UX-WAIT-02 UX-WAIT-04 REL-FAM-03
describe("the shared mascot wait (@space/ui/library-loading), one view for the desktops and web players", () => {
  it("shows the mascot above its text, and the text is the accessible status", () => {
    stubMotion();
    const { container } = render(<MascotLoading app="badger" src="badger.webp" label="Loading your account…" />);
    console.info(LOG, "labelled wait", container.innerHTML);
    const status = container.querySelector('[role="status"]')!;
    const mascot = status.querySelector('[data-testid="mascot-loader-badger"]')!;
    const text = status.querySelector("p")!;
    expect(mascot.getAttribute("aria-hidden")).toBe("true");
    expect(text.textContent).toBe("Loading your account…");
    expect(text.className).toBe("text-sm text-muted-foreground");
    expect(mascot.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the start's wait without text is the mascot alone, with no status to announce", () => {
    stubMotion();
    const { container } = render(<MascotLoading app="parrot" src="parrot.webp" />);
    console.info(LOG, "bare wait", container.innerHTML);
    expect(container.querySelector('[data-testid="mascot-loader-parrot"]')).not.toBeNull();
    expect(container.querySelector("[role]")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
  });

  it("the library's wait is always the status, placed by the app, with one status region only", () => {
    stubMotion();
    const { container } = render(
      <LibraryLoading app="parrot" src="parrot.webp" label="Loading library…" className="fixed inset-x-0 bottom-0 top-16 flex" />,
    );
    console.info(LOG, "library wait", container.innerHTML);
    const root = container.querySelector<HTMLElement>('[data-testid="library-loading"]')!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.className).toBe("fixed inset-x-0 bottom-0 top-16 flex");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(root.querySelector('[data-testid="mascot-loader-parrot"]')).not.toBeNull();
    expect(root.querySelector("p")!.textContent).toBe("Loading library…");
  });

  it("the four apps' waits are bindings of this view, not copies of it", () => {
    const root = join(__dirname, "../../..");
    const files = [
      "apps/badger/desktop/src/renderer/src/components/LoadingScreen.tsx",
      "apps/parrot/desktop/src/renderer/src/LoadingMascot.tsx",
      "apps/badger/web-player/src/components/LoadingMascot.tsx",
      "apps/parrot/web-player/src/LoadingMascot.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      console.info(LOG, file, source.match(/from "@space\/ui\/[^"]+"/g));
      expect(source).toContain('from "@space/ui/library-loading"');
      expect(source).not.toContain("@space/ui/mascot-loader");
      expect(source).not.toContain('role="status"');
    }
  });
});
