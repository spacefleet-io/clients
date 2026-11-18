import { describe, expect, it } from "vitest";
import {
  desktopTopNavActiveIconClassName,
  desktopTopNavDisabledClassName,
  desktopTopNavItemBaseClassName,
  desktopTopNavItemClassName,
  desktopTopNavTextActionBaseClassName,
  desktopTopNavTone,
} from "../src/components/desktop-top-nav-styles";

describe("desktop top nav styles", () => {
  console.info("[desktop-top-nav-styles:suite] starting desktop top-nav style helper tests");

  it("keeps the shared nav item metrics centralized", () => {
    console.info(`[desktop-top-nav-styles:test] base class="${desktopTopNavItemBaseClassName}"`);
    expect(desktopTopNavItemBaseClassName).toContain("px-3");
    expect(desktopTopNavItemBaseClassName).toContain("py-2");
    expect(desktopTopNavItemBaseClassName).toContain("tracking-[0.12em]");
  });

  it("composes active and disabled states deterministically", () => {
    const tone = { active: "active", idle: "idle", disabled: "disabled" };
    const activeClass = desktopTopNavItemClassName({ isActive: true, tone });
    const disabledClass = desktopTopNavItemClassName({ isActive: false, disabled: true, tone });
    console.info(`[desktop-top-nav-styles:test] activeClass="${activeClass}"`);
    console.info(`[desktop-top-nav-styles:test] disabledClass="${disabledClass}"`);
    console.info(`[desktop-top-nav-styles:test] textActionBase="${desktopTopNavTextActionBaseClassName}"`);

    expect(activeClass).toContain("active");
    expect(disabledClass).toBe(`${desktopTopNavItemBaseClassName} disabled`);
    expect(desktopTopNavTextActionBaseClassName).toContain("tracking-[0.12em]");
  });

  // @req UX-LIBTAB-01[badger-desktop,parrot,parrot-web-player]
  it("a disabled tab is the same greyed look with no hover, whether it would be active or not", () => {
    const disabled = desktopTopNavItemClassName({ isActive: false, disabled: true });
    const disabledActive = desktopTopNavItemClassName({ isActive: true, disabled: true });
    console.info(`[desktop-top-nav-styles:test] disabled="${disabled}"`);
    expect(disabled).toBe(disabledActive);
    expect(disabled).toContain(desktopTopNavDisabledClassName);
    expect(desktopTopNavDisabledClassName).toContain("opacity-50");
    expect(disabled).not.toContain("hover:");
  });

  // @req UX-TOP-03[badger-desktop,parrot]
  it("gives the selected tab's icon the app accent with the shared tone by default", () => {
    const active = desktopTopNavItemClassName({ isActive: true });
    const idle = desktopTopNavItemClassName({ isActive: false });
    console.info(`[desktop-top-nav-styles:test] default active="${active}" idle="${idle}"`);
    expect(active).toContain(desktopTopNavTone.active);
    expect(active).toContain(desktopTopNavActiveIconClassName);
    expect(desktopTopNavActiveIconClassName).toBe("[&_svg]:text-primary");
    expect(idle).toContain(desktopTopNavTone.idle);
    expect(idle).not.toContain("text-primary");
  });
});
