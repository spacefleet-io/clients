import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopWelcomeHero } from "../src/components/desktop-welcome-hero";

describe("desktop welcome hero", () => {
  it("keeps the shared widescreen hero frame and typography contract", () => {
    const html = renderToStaticMarkup(
      <DesktopWelcomeHero
        title="Welcome to Badger"
        subtitle="Your library is empty."
        action={<button type="button">Add media</button>}
        backgroundImageSrc="/hero.png"
        overlays={<div className="hero-overlay" />}
      />
    );

    expect(html).toContain("rounded-[32px]");
    expect(html).toContain("min-h-[340px]");
    expect(html).toContain("md:min-h-[380px]");
    expect(html).toContain("md:px-12");
    expect(html).toContain("max-w-2xl");
    expect(html).toContain("text-4xl font-black uppercase tracking-tight text-white md:text-6xl");
    expect(html).toContain("text-sm leading-7 text-white/60 md:text-base");
    expect(html).toContain("hero-overlay");
    expect(html).toContain('src="/hero.png"');
  });
});
