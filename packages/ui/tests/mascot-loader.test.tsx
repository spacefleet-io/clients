// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASCOT_LOADERS } from "@space/shared/mascotLoader";
import { MascotLoader } from "../src/mascot-loader";

const stubMotion = (reduced: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true, writable: true });
  return animate;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// @req UX-WAIT-02
describe("the loading-screen mascot (web and desktop)", () => {
  it("draws the app's picture plus Parrot's three notes, hidden from screen readers", () => {
    stubMotion(false);
    const { container } = render(<MascotLoader app="parrot" src="parrot.webp" size={120} />);
    const root = container.querySelector<HTMLElement>('[data-testid="mascot-loader-parrot"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.style.width).toBe("120px");
    expect(root.querySelector("img")!.getAttribute("src")).toBe("parrot.webp");
    // Tailwind's preflight `img { max-width: 100% }` would squash the picture to its zero-width layer (seen on the web player).
    expect(root.querySelector("img")!.style.maxWidth).toBe("none");
    expect(root.querySelectorAll("svg")).toHaveLength(3);
  });

  it("runs one endless 1.6 s loop per layer on the Web Animations API, and stops it on unmount", () => {
    const animate = stubMotion(false);
    const { unmount } = render(<MascotLoader app="badger" src="badger.webp" />);
    expect(animate).toHaveBeenCalledTimes(MASCOT_LOADERS.badger.layers.length);
    const [keyframes, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(options).toMatchObject({ duration: 1600, iterations: Infinity });
    expect(keyframes[0]!.transform).toBe(keyframes.at(-1)!.transform);
    const cancel = animate.mock.results[0]!.value.cancel;
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it("stands still when the system asks for reduced motion", () => {
    const animate = stubMotion(true);
    render(<MascotLoader app="parrot" src="parrot.webp" />);
    expect(animate).not.toHaveBeenCalled();
  });
});
