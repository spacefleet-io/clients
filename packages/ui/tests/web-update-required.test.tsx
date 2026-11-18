// @vitest-environment jsdom
/**
 * @test-id UI-WEB-UPDATE-REQUIRED-001
 * @level integration (jsdom)
 * @req REL-CD-29[badger-web-player] @req REL-CD-29[parrot-web-player]
 * @why Chris 2026-11-18 ("for outdated web tab go with (a)"): once the API refuses a web player's build, the page is
 *   dimmed under "SpaceFleet has been updated. Reload to continue" with the app's mascot and one Reload button, in the
 *   page's language; Reload reloads the whole tab (the website framing the player), or the page itself when the top
 *   frame is out of reach. Nothing shows before a refusal.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, setApiBaseUrl } from "@space/shared/api";
import { __resetAppVersionStateForTests } from "@space/shared/appVersion";
import { reloadWebTab, WebUpdateRequired } from "../src/web-update-required";

const log = (phase: string, data?: unknown) => console.info(`[UI-WEB-UPDATE-REQUIRED-001] ${phase}`, data === undefined ? "" : JSON.stringify(data));

const refuse = async (app: "badger" | "parrot") => {
  setApiBaseUrl("http://api.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "app_update_required", app, platform: "web", version: "2026.1101.1000", minVersion: "2026.1118.1915" }), { status: 426 }))
  );
  await act(async () => {
    await apiRequest("/me").catch(() => undefined);
  });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setApiBaseUrl("/api");
  __resetAppVersionStateForTests();
  document.documentElement.lang = "";
});

describe("web update notice", () => {
  it("shows nothing until a refusal, then the notice in the page's language with one Reload button", async () => {
    document.documentElement.lang = "fr";
    const onReload = vi.fn();
    render(<WebUpdateRequired app="parrot" mascotSrc="/parrot.webp" onReload={onReload} />);
    expect(screen.queryByTestId("web-update-required")).toBeNull();

    await refuse("parrot");
    const notice = screen.getByTestId("web-update-required");
    log("after refusal", { text: notice.textContent, glow: screen.getByTestId("web-update-required-mascot").innerHTML });
    expect(notice.className).toContain("fixed inset-0");
    expect(notice.className).toContain("bg-black/70");
    expect(screen.getByText("SpaceFleet a été mis à jour. Rechargez la page pour continuer")).toBeTruthy();
    expect(screen.getByTestId("web-update-required-mascot").innerHTML).toContain("64,221,143");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Recharger"]);
    fireEvent.click(buttons[0]!);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("speaks English for a language it does not have, with the Badger mascot", async () => {
    document.documentElement.lang = "ja";
    render(<WebUpdateRequired app="badger" mascotSrc="/badger.webp" onReload={() => undefined} />);
    await refuse("badger");
    expect(screen.getByText("SpaceFleet has been updated. Reload to continue")).toBeTruthy();
    expect(screen.getByRole("button").textContent).toBe("Reload");
    expect(screen.getByTestId("web-update-required-mascot").innerHTML).toContain("255,170,84");
  });

  it("Reload reloads the framing website, or the page itself when the top frame is out of reach", () => {
    const topReload = vi.fn();
    const selfReload = vi.fn();
    const framed = { location: { reload: selfReload }, top: { location: { reload: topReload } } } as unknown as Window;
    reloadWebTab(framed);
    const crossOrigin = {
      location: { reload: selfReload },
      get top(): Window {
        return {
          get location(): Location {
            throw new DOMException("Blocked a frame", "SecurityError");
          },
        } as unknown as Window;
      },
    } as unknown as Window;
    reloadWebTab(crossOrigin);
    const alone = { location: { reload: selfReload } } as { location: { reload: () => void }; top?: unknown };
    alone.top = alone;
    reloadWebTab(alone as unknown as Window);
    log("reloads", { top: topReload.mock.calls.length, self: selfReload.mock.calls.length });
    expect(topReload).toHaveBeenCalledTimes(1);
    expect(selfReload).toHaveBeenCalledTimes(2);
  });
});
