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
    // About a fifth of the card's width (at most 17% of a short window's height), lifted by 55% of its height so its
    // lower 45% sits on the card, above the card.
    expect(box).toContain("w-[clamp(6rem,min(22%,17vh),9rem)]");
    expect(box).toContain("-translate-y-[55%]");
    expect(box).toContain("z-10");
    // The phone's glow: a disc of the app's colour at 16% behind the mascot.
    expect(box).toContain("rounded-full bg-primary opacity-[0.16]");
    expect(html).toContain("animate-float");
    // The header clears the overlap (45% of the mascot's width) plus 12 px.
    expect(html).toContain("pt-[clamp(3.5rem,calc(min(9.9%,7.65vh)_+_0.75rem),4.75rem)]");
    expect(html).not.toContain("-translate-y-[120%]");
  });

  it("DESKTOP-SHELL-STARTUP-MASCOT-002: a sign-in screen keeps the small mascot floating apart above the card", () => {
    const html = render({ mascotPlacement: "above" });
    console.info(LOG, "DESKTOP-SHELL-STARTUP-MASCOT-002", html.length);
    expect(html).not.toContain('data-testid="startup-card-mascot"');
    expect(html).toContain("-translate-y-[120%]");
    expect(html).toContain("h-20 w-20");
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
