import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Bell } from "lucide-react";
import { DesktopTopNavIconAction, DesktopTopNavTextAction } from "../src/components/desktop-top-nav-actions";

describe("desktop top nav actions", () => {
  it("renders the shared icon action shell", () => {
    const html = renderToStaticMarkup(
      <DesktopTopNavIconAction title="Notifications">
        <Bell className="h-4 w-4" />
      </DesktopTopNavIconAction>
    );

    expect(html).toContain("relative");
    expect(html).toContain("Notifications");
    expect(html).toContain("h-4 w-4");
  });

  it("renders the shared text action shell", () => {
    const html = renderToStaticMarkup(<DesktopTopNavTextAction>Sign out</DesktopTopNavTextAction>);

    expect(html).toContain("tracking-[0.12em]");
    expect(html).toContain("Sign out");
  });
});
