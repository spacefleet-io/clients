/**
 * @test-id PARROT-MOBILE-SCREEN-LAYOUT-001
 * @level unit
 * @req ACCT-UNPAID-05[parrot]
 * @req ACCT-UNPAID-03[parrot]
 * @req UX-NOTICE-08[parrot]
 * @why Chris 2026-11-26: the unpaid sign shows on every screen a signed-in listener can reach, the tab pages and every
 *   page pushed over them or opened from a link, and stays out of the player (ACCT-UNPAID-05); it is a small floating
 *   sign, never a strip (UX-NOTICE-08). The phone's navigator puts `ScreenLayout` around every screen
 *   (`screenLayout`): it hands the session's access to the shared `UnpaidScreenLayout` on the tab page, on an album or
 *   artist opened over it or from a link, marks only the player as playing, and marks the tab page ("Main") as carrying
 *   the sign on its tab bar (MainScreen). What `UnpaidScreenLayout` draws (the floating sign, the screen left in place,
 *   nothing on the player or under the tab bar's sign) is tested in mobile-shell.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "[PARROT-MOBILE-SCREEN-LAYOUT-001]";
const log = (step: string, detail: unknown) => console.info(`${SUITE} ${step}`, JSON.stringify(detail));
const session = vi.hoisted(() => ({ access: null as { state: string; wipeAt: string | null } | null }));

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
vi.mock("../src/state/session", () => ({ useSession: () => ({ access: session.access }) }));

import { ScreenLayout } from "../src/navigation/ScreenLayout";

const UNPAID = { state: "unpaid", wipeAt: "2027-01-22T00:00:00.000Z" };
let tree: ReactTestRenderer | null = null;

const render = async (name: string) => {
  log(`${name}: mount`, { access: session.access });
  await act(async () => {
    tree = create(
      <ScreenLayout route={{ name, key: `${name}-1` }} navigation={{ addListener: () => () => undefined } as never}>
        {createElement("Screen", { name })}
      </ScreenLayout>,
    );
  });
  const [layout] = tree!.root.findAll((node) => String(node.type) === "UnpaidScreenLayout");
  const [sky] = tree!.root.findAll((node) => String(node.type) === "MobileSkyScreenLayout");
  const screens = layout!.findAll((node) => String(node.type) === "Screen");
  log(`${name}: rendered`, { access: layout!.props.access, playing: layout!.props.playing, sky: sky!.props.sky, screensInside: screens.length });
  return {
    notice: layout!.props as { access: unknown; playing: boolean; onTabBar?: boolean },
    sky: sky!.props.sky as boolean,
    screensInside: screens.length,
  };
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  session.access = UNPAID;
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});
describe("the phone's navigator puts the unpaid notice around every screen (ACCT-UNPAID-05)", () => {
  for (const name of ["Main", "Album", "Artist", "Playlist", "PairDevice", "OfflineContent", "DeleteAccount"]) {
    it(`${name}: an unpaid account's access reaches the notice around the screen`, async () => {
      const { notice, sky, screensInside } = await render(name);
      expect(notice.access).toEqual(UNPAID);
      expect(notice.playing).toBe(false);
      expect(notice.onTabBar === true).toBe(name === "Main");
      expect(screensInside).toBe(1);
      expect(sky).toBe(true);
    });
  }

  it("the player is marked playing, so it shows no notice and paints its own sky", async () => {
    const { notice, sky } = await render("Player");
    expect(notice.access).toEqual(UNPAID);
    expect(notice.playing).toBe(true);
    expect(sky).toBe(false);
  });
});
