// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AppBrand, { APP_BRAND_WIGGLE } from "../src/app-brand";

// @req PAR-LOOK-03
describe("[parrot] app brand", () => {
  it("giggles the logo on hover with Badger's motion: 560 ms ease-out, once, off under reduced motion", () => {
    const html = renderToStaticMarkup(<AppBrand logoSrc="/parrot.webp" logoAlt="Parrot" title="Parrot" />);
    console.info("[app-brand] markup", html);
    expect(APP_BRAND_WIGGLE).toEqual({ name: "app-brand-wiggle", durationMs: 560, easing: "ease-out" });
    expect(html).toContain("app-brand-link");
    expect(html).toContain("app-brand-mark");
    expect(html).toContain("@keyframes app-brand-wiggle");
    expect(html).toContain(".app-brand-link:hover .app-brand-mark");
    expect(html).toContain("animation: app-brand-wiggle 560ms ease-out 1");
    expect(html).toContain("prefers-reduced-motion: no-preference");
    expect(html).toContain("rotate(-8deg) scale(1.04)");
    expect(html).toContain(">Parrot<");
    expect(html).not.toContain("SpaceParrot");
  });

  // @req UX-BRAND-02
  it("only the logo and the name start the wiggle: the hover box is shrink-wrapped, not the header column", () => {
    const html = renderToStaticMarkup(<AppBrand logoSrc="/badger.png" logoAlt="" title="Badger" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const outer = doc.querySelector('[data-testid="app-brand"]');
    const hit = doc.querySelector('[data-testid="app-brand-hit"]');
    console.info("[app-brand] outer class:", outer?.className, "| hit:", hit?.tagName, hit?.className);
    expect(outer?.classList.contains("app-brand-link")).toBe(false);
    expect(hit?.classList.contains("app-brand-link")).toBe(true);
    expect(hit?.classList.contains("inline-flex")).toBe(true);
    expect(hit?.classList.contains("w-fit")).toBe(true);
    expect(hit?.querySelector("img.app-brand-mark")).not.toBeNull();
    expect(hit?.querySelector(".app-brand-wordmark")?.textContent).toBe("Badger");
  });
});
