/**
 * @req ACCT-UNPAID-05[badger-desktop] @req UX-NOTICE-08[badger-desktop]
 * @why Chris 2026-11-26: the unpaid notice shows on every screen a signed-in user can reach. On the desktop the notice
 *   is a small sign in the top bar's status slot (`TopNav` renders `UnpaidAccessSign`, tested in
 *   unpaid-access-sign.test.tsx; UX-NOTICE-08 forbids a strip that pushes the page down), so every
 *   route of the signed-in app must draw the top bar, itself or through the settings layout. A new route that drew
 *   neither would leave an unpaid account without the notice. `/onboarding/key` is the setup step before the app opens
 *   (the recovery key), so it has no top bar; the player plays in mpv's own window, outside these routes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SUITE = "[badger-desktop:unpaid-notice-every-route]";
const renderer = join(process.cwd(), "src/renderer/src");
const source = (file: string) => readFileSync(join(renderer, file), "utf8");
const SETUP_ONLY_ROUTE = "/onboarding/key";

/** Every `<Route path=… element={…}>` of the signed-in app that renders a page (not a redirect), with that page. */
const pageRoutes = () => {
  const app = source("AuthenticatedApp.tsx");
  const lazyPages = new Map([...app.matchAll(/const (\w+) = lazy\(\(\) => import\("\.\/pages\/(\w+)"\)\)/g)].map((m) => [m[1]!, m[2]!]));
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)].map((m) => ({ path: m[1]!, element: m[2]! }));
  return routes
    .filter((route) => !route.element.includes("<Navigate"))
    .map((route) => {
      const used = [...route.element.matchAll(/<(\w+)\s*\/>/g)].map((m) => m[1]!);
      const page = used.find((name) => lazyPages.has(name));
      return { path: route.path, page: page ? lazyPages.get(page)! : null };
    });
};

describe("@req ACCT-UNPAID-05[badger-desktop] every route of the signed-in desktop app shows the unpaid notice", () => {
  it("the top bar's status slot always renders the unpaid sign, and the settings layout renders the top bar", () => {
    const topNav = source("components/TopNav.tsx");
    const statusSlot = topNav.match(/status=\{([\s\S]*?)\n {8}\}/)?.[1] ?? "";
    console.info(`${SUITE} TopNav status slot renders UnpaidAccessSign`, statusSlot.includes("<UnpaidAccessSign />"));
    expect(statusSlot).toContain("<UnpaidAccessSign />");
    // UX-NOTICE-08: no strip under the bar, for unpaid or for a library over its storage.
    expect(topNav).not.toContain("UnpaidAccessBanner");
    expect(statusSlot).toContain("<OverQuotaSign />");
    expect(topNav).not.toContain("OverQuotaBanner");
    expect(source("components/settings/SettingsLayout.tsx")).toContain("<TopNav />");
  });

  it("each page route draws the top bar, itself or through the settings layout; only the key setup step does not", () => {
    const routes = pageRoutes();
    console.info(`${SUITE} page routes`, JSON.stringify(routes));
    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining(["/home", "/media-library", "/playlists", "/media/:id", "/media-library/add", "/settings", "/account"]),
    );
    const missing: string[] = [];
    for (const route of routes) {
      if (route.path === SETUP_ONLY_ROUTE) continue;
      expect(route.page, `${route.path} renders a page`).not.toBeNull();
      const page = source(`pages/${route.page}.tsx`);
      const drawsTopBar = page.includes("<TopNav />") || page.includes("<SettingsLayout");
      console.info(`${SUITE} ${route.path} -> pages/${route.page}.tsx`, { drawsTopBar });
      if (!drawsTopBar) missing.push(route.path);
    }
    expect(missing).toEqual([]);
  });
});
