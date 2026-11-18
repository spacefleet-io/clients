import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAppTopNav } from "../src/components/desktop-app-top-nav";

describe("desktop app top nav", () => {
  it("composes the shared brand, nav, and right-side action slots", () => {
    const html = renderToStaticMarkup(
      <DesktopAppTopNav
        logoSrc="/icon.png"
        logoAlt="Badger"
        title="Badger"
        desktopNav={<nav>nav</nav>}
        leadingActions={<div>jobs</div>}
        notificationAction={<div>notifications</div>}
        accountAction={<div>account</div>}
        signOutAction={<div>signout</div>}
      />
    );

    expect(html).toContain("app-brand-link");
    expect(html).toContain(">nav<");
    expect(html).toContain(">jobs<");
    expect(html).toContain(">notifications<");
    expect(html).toContain(">account<");
    expect(html).toContain(">signout<");
  });
});
