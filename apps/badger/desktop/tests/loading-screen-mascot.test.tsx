// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-LOADING-MASCOT-001
 * @level unit
 * @req UX-WAIT-02[badger-desktop]
 * @why Chris 2026-11-11: the loading screens Badger shows while it opens get the hovering badger ABOVE the loading text,
 *   and the text itself stays exactly as it was (same key, same place). Covers the full-screen wait (account, app,
 *   profiles) and the library's own "Loading library…" wait.
 * @covers apps/badger/desktop/src/renderer/src/components/LoadingScreen.tsx, apps/badger/desktop/src/renderer/src/components/profiles/ProfileGate.tsx, apps/badger/desktop/src/renderer/src/pages/Library.tsx
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[BADGER-DESKTOP-LOADING-MASCOT-001]";
const say = (line: string, extra?: unknown) => console.info(`${LOG} ${line}`, extra ?? "");

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/profileStore", () => ({ useProfiles: () => ({ userId: "user-1", status: "loading", needsChoice: false }) }));

import { LoadingScreen } from "../src/renderer/src/components/LoadingScreen";
import ProfileGate from "../src/renderer/src/components/profiles/ProfileGate";

const source = (path: string) => readFileSync(join(process.cwd(), "src/renderer/src", path), "utf8");

/** The mascot sits above the text: it comes first in the document and the text is not inside it. */
const expectMascotAboveText = (host: HTMLElement, text: string) => {
  const mascot = host.querySelector('[data-testid="mascot-loader-badger"]');
  const label = [...host.querySelectorAll("div")].find((el) => el.textContent === text && el.children.length === 0);
  say("markup", host.innerHTML);
  expect(mascot).not.toBeNull();
  expect(mascot?.getAttribute("aria-hidden")).toBe("true");
  expect(label).toBeDefined();
  expect(mascot!.contains(label!)).toBe(false);
  expect(mascot!.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(label!.className).toBe("text-sm text-muted-foreground");
};

describe("Badger desktop loading screens: hovering badger above the unchanged text", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("the full-screen loading screen shows the mascot above its label", async () => {
    await act(async () => root.render(<LoadingScreen label="Loading your account…" />));
    expectMascotAboveText(host, "Loading your account…");
  });

  it("the profiles gate waits on the same screen with app.loading", async () => {
    await act(async () => root.render(<ProfileGate><div data-testid="app-content" /></ProfileGate>));
    expect(host.querySelector('[data-testid="app-content"]')).toBeNull();
    expectMascotAboveText(host, "app.loading");
  });

  it("every opening wait uses the shared screen, with its loading keys unchanged", () => {
    const app = source("App.tsx");
    const authenticated = source("AuthenticatedApp.tsx");
    say("App.tsx loading screens", app.match(/<LoadingScreen[^>]*>/g));
    say("AuthenticatedApp.tsx loading screens", authenticated.match(/<LoadingScreen[^>]*>/g));
    for (const file of [app, authenticated]) {
      expect(file).toMatch(/import \{ LoadingScreen \} from "(\.|@)\/components\/LoadingScreen";/);
      expect(file).not.toMatch(/const LoadingScreen = /);
    }
    expect(app).toContain('<LoadingScreen label={t("app.loadingAccount")} />');
    expect(app).toContain('<LoadingScreen label={t("app.loading")} />');
    expect(authenticated).toContain('<LoadingScreen label={t("app.loading")} />');
  });

  it("the library's own wait puts the mascot right above the unchanged library.loading text", () => {
    const library = source("pages/Library.tsx");
    const mascotAt = library.indexOf('<MascotLoader app="badger" src={mascotUrl} size={120} />');
    const textAt = library.indexOf('<div className="text-sm text-[#8b949e]">{t("library.loading")}</div>');
    say("Library.tsx offsets", { mascotAt, textAt });
    expect(mascotAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(mascotAt);
    // Nothing between the mascot line and the text line.
    expect(library.slice(mascotAt, textAt).trim().split("\n")).toHaveLength(1);
  });
});
