import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopStartupCard } from "../src/components/desktop-startup-card";
import { DesktopStartupControls } from "../src/components/desktop-startup-controls";
import { DesktopStartupPage } from "../src/components/desktop-startup-page";

// On assertion failure, dump the full rendered markup + which expected class
// strings are present, so a contract drift is diagnosable without re-rendering.
// Wrapped in try/catch so a dump failure can't mask the original assertion.
const dumpStartupSnapshot = (label: string, html: string, needles: string[]) => {
  try {
    console.error(`=== [startup-shell:${label}] rendered markup snapshot ===`);
    console.error(`html length=${html.length} chars`);
    for (const needle of needles) {
      console.error(`  must-contain ${JSON.stringify(needle)} present=${html.includes(needle)}`);
    }
    console.error(`full html:\n${html}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop startup shell", () => {
  it("keeps the shared startup page and controls dock contract", () => {
    console.info(`[startup-shell:page-contract] rendering DesktopStartupPage + controls dock`);
    const html = renderToStaticMarkup(
      <DesktopStartupPage topNav={<div className="top-nav" />} controls={<DesktopStartupControls><button>Lang</button></DesktopStartupControls>}>
        <div className="startup-body" />
      </DesktopStartupPage>
    );
    console.info(`[startup-shell:page-contract] rendered, html length=${html.length} chars`);

    const needles = [
      "min-h-screen",
      'data-testid="app-backdrop"',
      "container flex min-h-[calc(100vh-4rem)] items-center justify-center py-0 relative z-10",
      "fixed right-8 top-20 z-50 flex items-center gap-2",
      "top-nav",
      "startup-body",
    ];
    if (!needles.every((n) => html.includes(n))) dumpStartupSnapshot("page-contract", html, needles);

    expect(html).toContain("min-h-screen");
    expect(html).toContain('data-testid="app-backdrop"');
    expect(html).toContain("container flex min-h-[calc(100vh-4rem)] items-center justify-center py-0 relative z-10");
    expect(html).toContain("fixed right-8 top-20 z-50 flex items-center gap-2");
    expect(html).toContain("top-nav");
    expect(html).toContain("startup-body");
  });

  it("keeps the shared startup card contract for auth and onboarding flows", () => {
    console.info(`[startup-shell:card-contract] rendering DesktopStartupCard`);
    const html = renderToStaticMarkup(
      <DesktopStartupCard
        eyebrow="Shared startup shell"
        title="Verify your email"
        description="Enter the code to continue."
        mascotSrc="/mascot.webp"
        mascotAlt="Mascot"
        mascotGlowClassName="drop-shadow-[0_0_30px_rgba(204,124,255,0.35)]"
        headerActions={<button type="button">Language</button>}
        contentClassName="space-y-4"
      >
        <form className="startup-form" />
      </DesktopStartupCard>
    );
    console.info(`[startup-shell:card-contract] rendered, html length=${html.length} chars`);

    const needles = [
      "relative w-full max-w-md",
      "animate-float",
      "drop-shadow-[0_0_30px_rgba(204,124,255,0.35)]",
      "text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 sm:text-xs",
      "flex items-start justify-between gap-3 text-left",
      "startup-form",
      'src="/mascot.webp"',
    ];
    if (!needles.every((n) => html.includes(n))) dumpStartupSnapshot("card-contract", html, needles);

    expect(html).toContain("relative w-full max-w-md");
    expect(html).toContain("animate-float");
    expect(html).toContain("drop-shadow-[0_0_30px_rgba(204,124,255,0.35)]");
    expect(html).toContain("text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 sm:text-xs");
    expect(html).toContain("flex items-start justify-between gap-3 text-left");
    expect(html).toContain("startup-form");
    expect(html).toContain('src="/mascot.webp"');
  });
});
