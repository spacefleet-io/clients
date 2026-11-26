/**
 * @test-id BADGER-MOBILE-SCREEN-LAYOUT-UNPAID-001
 * @level unit
 * @req ACCT-UNPAID-05[badger-mobile]
 * @req ACCT-UNPAID-05[badger-tv]
 * @req ACCT-UNPAID-03[badger-mobile]
 * @req ACCT-UNPAID-03[badger-tv]
 * @req UX-NOTICE-08[badger-mobile]
 * @req UX-NOTICE-08[badger-tv]
 * @why Chris 2026-11-26: the unpaid sign shows on every screen a signed-in viewer can reach, the tab pages and every
 *   screen pushed over them or opened from a link or a notification (a film's page, pairing), and stays out of the
 *   player while a title plays (ACCT-UNPAID-05); it is a small floating sign, never a strip (UX-NOTICE-08). The
 *   navigator puts `ScreenLayout` around every screen (`screenLayout`): it hands the account's access to the shared
 *   `UnpaidScreenLayout` on every route, sized for the TV and under its top bar on the TV, marks only the player as
 *   playing, and marks the phone's tab pages ("Main") as carrying the sign on their tab bar (MainShellScreen, tested
 *   in main-shell-offline-notice). What `UnpaidScreenLayout` draws (the floating sign, the screen left in place,
 *   nothing on the player or under the tab bar's sign, nothing to press) is tested in mobile-shell.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "[BADGER-MOBILE-SCREEN-LAYOUT-UNPAID-001]";
const log = (step: string, detail: unknown) => console.info(`${SUITE} ${step}`, JSON.stringify(detail));
const h = vi.hoisted(() => ({ access: null as { state: string; wipeAt: string | null } | null, tv: false }));

vi.mock("@space/mobile-shell/render-boundary", () => ({
  MobileRenderBoundary: ({ children, ...props }: { children?: ReactNode }) => createElement("MobileRenderBoundary", props, children),
}));
vi.mock("@space/mobile-shell/components", () => ({
  MobileSkyScreenLayout: ({ children, navigation: _navigation, ...props }: { children?: ReactNode; navigation: unknown }) =>
    createElement("MobileSkyScreenLayout", props, children),
}));
vi.mock("@space/mobile-shell/unpaid-access-sign", () => ({
  UnpaidScreenLayout: ({ children, ...props }: { children?: ReactNode }) => createElement("UnpaidScreenLayout", props, children),
}));
vi.mock("@space/mobile-shell/tv/tvScale", () => ({ useTvScale: () => 1.5 }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ user: { id: "u1", access: h.access } }) }));
vi.mock("../src/tv/lib/tvRuntime", () => ({
  get IS_TV() {
    return h.tv;
  },
}));

import { ScreenLayout } from "../src/navigation/ScreenLayout";

const UNPAID = { state: "unpaid", wipeAt: "2027-01-22T00:00:00.000Z" };
let tree: ReactTestRenderer | null = null;

const render = async (name: string) => {
  log(`${name}: mount`, { access: h.access, tv: h.tv });
  await act(async () => {
    tree = create(
      createElement(ScreenLayout, {
        route: { name, key: `${name}-1` },
        navigation: { addListener: () => () => undefined } as never,
        children: createElement("Screen", { name }),
      }),
    );
  });
  const [layout] = tree!.root.findAll((node) => String(node.type) === "UnpaidScreenLayout");
  const screens = layout!.findAll((node) => String(node.type) === "Screen");
  const notice = {
    access: layout!.props.access,
    playing: layout!.props.playing,
    onTabBar: layout!.props.onTabBar,
    tv: layout!.props.tv,
    scale: layout!.props.scale,
  };
  log(`${name}: rendered`, { ...notice, screensInside: screens.length });
  return { notice, screensInside: screens.length };
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.access = UNPAID;
  h.tv = false;
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});

describe("the navigator puts the unpaid notice around every screen (ACCT-UNPAID-05)", () => {
  // MediaDetails and PairDevice are what a link or a notification opens; the rest are pushed from the tabs.
  for (const name of ["Main", "MediaDetails", "PairDevice", "PlaylistDetail", "Downloads", "OfflineContent", "Feedback", "TvRemote", "Cast"]) {
    it(`phone, ${name}: an unpaid account's access reaches the notice around the screen`, async () => {
      const { notice, screensInside } = await render(name);
      expect(notice).toEqual({ access: UNPAID, playing: false, onTabBar: name === "Main", tv: false, scale: 1 });
      expect(screensInside).toBe(1);
    });
  }

  it("TV, MediaDetails: the notice is sized for the TV", async () => {
    h.tv = true;
    const { notice } = await render("MediaDetails");
    expect(notice).toEqual({ access: UNPAID, playing: false, onTabBar: false, tv: true, scale: 1.5 });
  });

  it("the player is marked playing, so it shows no notice while a title plays", async () => {
    for (const tv of [false, true]) {
      h.tv = tv;
      const { notice } = await render("Player");
      expect(notice.playing).toBe(true);
    }
  });
});
