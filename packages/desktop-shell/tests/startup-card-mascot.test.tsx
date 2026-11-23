/**
 * @req UX-SETUP-08[badger-desktop,parrot]
 * @test-id DESKTOP-SHELL-STARTUP-MASCOT-001..003
 * @level unit
 * @why The computer's setup steps draw the mascot as the phone does: large, about half over the card's top border, with
 *   the phone's soft disc of the app's colour behind it and the card's top padded so nothing sits under it. The sign-in
 *   screens keep the small mascot floating apart above the card, as the phone's sign-in does.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopStartupCard } from "../src/components/desktop-startup-card";

const LOG = "[startup-card-mascot.test]";

const render = (props: Partial<Parameters<typeof DesktopStartupCard>[0]>) =>
  renderToStaticMarkup(
    <DesktopStartupCard title="Your profile" mascotSrc="/mascot.webp" mascotAlt="Mascot" {...props}>
      <div className="body" />
    </DesktopStartupCard>,
  );

describe("the startup card's mascot", () => {
  it("DESKTOP-SHELL-STARTUP-MASCOT-001: a setup step draws it over the card's top border with the glow disc, the header padded below it", () => {
    const html = render({});
    console.info(LOG, "DESKTOP-SHELL-STARTUP-MASCOT-001", html.length);
    const box = html.slice(html.indexOf('data-testid="startup-card-mascot"') - 200, html.indexOf('src="/mascot.webp"'));
    expect(html).toContain('data-testid="startup-card-mascot"');
    // About 15% of the card's width (64 to 96 px, at most 12% of a short window's height: two thirds of the first size,
    // Chris 2026-11-19), lifted by 55% of its height so its lower 45% sits on the card, above the card.
    expect(box).toContain("w-[clamp(4rem,min(15%,12vh),6rem)]");
    expect(box).toContain("-translate-y-[55%]");
    expect(box).toContain("z-10");
    // The phone's glow: a disc of the app's colour at 16% behind the mascot.
    expect(box).toContain("rounded-full bg-primary opacity-[0.16]");
    expect(html).toContain("animate-float");
    // The header clears the overlap (45% of the mascot's width) plus 12 px.
    expect(html).toContain("pt-[clamp(2.55rem,calc(min(6.75%,5.4vh)_+_0.75rem),3.45rem)]");
    expect(html).not.toContain("-translate-y-[120%]");
  });

  it("DESKTOP-SHELL-STARTUP-MASCOT-002: a sign-in screen keeps the small mascot floating apart above the card, in its own room", () => {
    const html = render({ mascotPlacement: "above" });
    console.info(LOG, "DESKTOP-SHELL-STARTUP-MASCOT-002", html.length);
    expect(html).not.toContain('data-testid="startup-card-mascot"');
    const mascot = html.slice(html.indexOf("<div"), html.indexOf('data-testid="startup-card"'));
    console.info(LOG, "DESKTOP-SHELL-STARTUP-MASCOT-002 mascot markup", mascot);
    expect(mascot).toContain('data-testid="startup-card-mascot-above"');
    expect(mascot).toContain("h-20 w-20");
    // In the flow above the card, not lifted out of it: a card taller than the window used to push an absolutely placed
    // mascot under Badger's top bar (2026-11-23).
    expect(mascot).toContain("mx-auto mb-4");
    expect(html).not.toContain("absolute left-1/2 top-0 -translate-x-1/2");
    expect(html).not.toContain("pt-[clamp(");
    expect(html).toContain("pt-8");
  });

  it("DESKTOP-SHELL-STARTUP-MASCOT-003: with no mascot the card keeps its usual top padding", () => {
    const html = render({ mascotSrc: null });
    console.info(LOG, "DESKTOP-SHELL-STARTUP-MASCOT-003", html.length);
    expect(html).not.toContain("mascot.webp");
    expect(html).not.toContain("pt-[clamp(");
    expect(html).toContain("pt-8");
  });
});
