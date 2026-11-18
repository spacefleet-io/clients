import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTopNavFrame } from "../src/components/desktop-top-nav-frame";

// On assertion failure, dump the full rendered markup so a className regression
// can be diagnosed without re-rendering by hand. Wrapped in try/catch so a dump
// failure can't mask the original assertion error.
const dumpNavFrameSnapshot = (
  label: string,
  html: string,
  expectations: { mustContain?: string[]; mustNotContain?: string[] },
) => {
  try {
    console.error(`=== [top-nav-frame:${label}] rendered markup snapshot ===`);
    console.error(`html length=${html.length} chars`);
    for (const needle of expectations.mustContain ?? []) {
      console.error(`  must-contain ${JSON.stringify(needle)} present=${html.includes(needle)}`);
    }
    for (const needle of expectations.mustNotContain ?? []) {
      console.error(`  must-NOT-contain ${JSON.stringify(needle)} present=${html.includes(needle)}`);
    }
    console.error(`full html:\n${html}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop top nav frame", () => {
  it("[@bugfix][@regression-proof] keeps desktop nav centered while actions stay right-aligned", () => {
    console.info(`[top-nav-frame:centered] rendering DesktopTopNavFrame (default centered layout)`);
    const html = renderToStaticMarkup(
      <DesktopTopNavFrame
        brand={<div>brand</div>}
        desktopNav={<nav>nav</nav>}
        desktopActions={<div>actions</div>}
        mobileActions={<div>mobile</div>}
      />
    );
    console.info(`[top-nav-frame:centered] rendered, html length=${html.length} chars`);

    const mustContain = [
      "md:grid-cols-[1fr_auto_1fr]",
      "justify-self-center",
      "justify-self-end",
      "w-full",
      "px-8",
    ];
    const mustNotContain = ["container", "max-w-[1400px]", "px-4", "px-6", "lg:px-8"];
    const ok =
      mustContain.every((n) => html.includes(n)) && mustNotContain.every((n) => !html.includes(n));
    if (!ok) dumpNavFrameSnapshot("centered", html, { mustContain, mustNotContain });

    expect(html).toContain("md:grid-cols-[1fr_auto_1fr]");
    expect(html).toContain("justify-self-center");
    expect(html).toContain("justify-self-end");
    expect(html).toContain("w-full");
    expect(html).toContain("px-8");
    expect(html).not.toContain("container");
    expect(html).not.toContain("max-w-[1400px]");
    expect(html).not.toContain("px-4");
    expect(html).not.toContain("px-6");
    expect(html).not.toContain("lg:px-8");
  });

  it("supports the trailing desktop layout for app shells that keep nav and actions grouped right", () => {
    console.info(`[top-nav-frame:trailing] rendering DesktopTopNavFrame (desktopLayout=trailing)`);
    const html = renderToStaticMarkup(
      <DesktopTopNavFrame
        brand={<div>brand</div>}
        desktopNav={<nav>nav</nav>}
        desktopActions={<div>actions</div>}
        desktopLayout="trailing"
      />
    );
    console.info(`[top-nav-frame:trailing] rendered, html length=${html.length} chars`);

    const mustContain = ["md:ml-auto", "md:flex", "md:items-center", "md:gap-3"];
    const mustNotContain = ["md:grid-cols-[1fr_auto_1fr]"];
    const ok =
      mustContain.every((n) => html.includes(n)) && mustNotContain.every((n) => !html.includes(n));
    if (!ok) dumpNavFrameSnapshot("trailing", html, { mustContain, mustNotContain });

    expect(html).toContain("md:ml-auto");
    expect(html).toContain("md:flex");
    expect(html).toContain("md:items-center");
    expect(html).toContain("md:gap-3");
    expect(html).not.toContain("md:grid-cols-[1fr_auto_1fr]");
  });

  // Since #1402 (UX-I18N-01) the balanced bar is a grid whose side columns never shrink below their content, so a long
  // nav label (fr/nl/de) pushes the nav aside instead of sliding under the actions; with room to spare it stays centred.
  it("supports the balanced desktop layout with left brand, centered nav, and right actions", () => {
    console.info(`[top-nav-frame:balanced] rendering DesktopTopNavFrame (desktopLayout=balanced)`);
    const html = renderToStaticMarkup(
      <DesktopTopNavFrame
        brand={<div>brand</div>}
        desktopNav={<nav>nav</nav>}
        desktopActions={<div>actions</div>}
        desktopLayout="balanced"
      />
    );
    console.info(`[top-nav-frame:balanced] rendered, html length=${html.length} chars`);

    const mustContain = [
      "md:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]",
      '<div class="hidden md:flex md:items-center"><nav>nav</nav></div>',
      '<div class="hidden md:flex md:items-center md:justify-end md:gap-3"><div>actions</div></div>',
    ];
    // The old absolute centring let a long nav slide under the actions.
    const mustNotContain = ["left-1/2", "-translate-x-1/2", "md:grid-cols-[1fr_auto_1fr]"];
    const ok =
      mustContain.every((n) => html.includes(n)) && mustNotContain.every((n) => !html.includes(n));
    if (!ok) dumpNavFrameSnapshot("balanced", html, { mustContain, mustNotContain });

    for (const needle of mustContain) expect(html).toContain(needle);
    for (const needle of mustNotContain) expect(html).not.toContain(needle);
  });

  // @req UX-NOTICE-02[badger-desktop]
  it("[@bugfix][@regression-proof] puts state signs beside the brand inside the fixed bar, at every width", () => {
    const html = renderToStaticMarkup(
      <DesktopTopNavFrame
        brand={<div>brand</div>}
        status={<span data-testid="sign">offline</span>}
        desktopNav={<nav>nav</nav>}
        desktopActions={<div>actions</div>}
        desktopLayout="balanced"
      />
    );
    console.info(`[top-nav-frame:status] ${html}`);
    const header = html.slice(0, html.indexOf("</header>"));
    const ok = header.includes('<div>brand</div><span data-testid="sign">offline</span>');
    if (!ok) dumpNavFrameSnapshot("status", html, { mustContain: ['<span data-testid="sign">'] });
    expect(ok).toBe(true);
    // Not hidden on narrow windows, and nothing but the height spacer after the header.
    expect(header).not.toMatch(/hidden[^>]*><div>brand<\/div><span/);
    expect(html.slice(html.indexOf("</header>"))).toBe('</header><div class="h-16"></div>');
  });
});
