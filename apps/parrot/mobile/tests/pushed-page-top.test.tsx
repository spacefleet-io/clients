/**
 * @test-id PARROT-MOBILE-PUSHED-PAGE-TOP-001
 * @level unit
 * @req UX-SKY-04[parrot] UX-PHONE-13[parrot]
 * @why Chris 2026-11-18 (App Store shot 02-album): the album page had a solid header bar over the sky, so the green
 *   nebula started under it and the page looked cut in two, and on iOS the back arrow sat in a clipped half pill. The
 *   album, artist and playlist pages now hide the navigator's header: their sky runs up behind the status bar, and a
 *   round back button floats under the status bar, with the content starting below it. The button is called as a
 *   function against a mocked React Native; the look is tried on an iPhone simulator and a phone. The back button is
 *   the shared 48 dp MobileIconButton (UX-PHONE-13): it was a 44 dp Pressable of its own until 2026-11-27.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-PUSHED-PAGE-TOP-001] phase=${phase}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, default: actual };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 59, left: 0, right: 0, bottom: 34 }) }));
vi.mock("lucide-react-native", () => ({ ArrowLeft: "Icon:ArrowLeft" }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => `t:${key}` }) }));
// The shared button's own size and press are proven in packages/mobile-shell/tests/mobile-icon-button.test.tsx.
vi.mock("@space/mobile-shell/components", () => ({ MobileIconButton: "MobileIconButton", MOBILE_ICON_BUTTON_SIZE: 48 }));

import { PAGE_BACK_ROW, PageBackButton, usePageTop } from "../src/screens/pageBack";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : ((style as Record<string, unknown>) ?? {});
const source = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

describe("PARROT-MOBILE-PUSHED-PAGE-TOP-001 album, artist and playlist pages stand on one sky", () => {
  it("floats a round back button under the status bar, in the app's language, that goes back", () => {
    let back = 0;
    const row = (PageBackButton as unknown as (props: unknown) => Element)({ onPress: () => back++ });
    const button = row.props.children as Element;
    const rowStyle = flat(row.props.style);
    const buttonStyle = flat(button.props.style);
    log("button", { type: button.type, rowStyle, buttonStyle, label: button.props.label });
    // The page content's left margin (the lists pad 16): button, titles and rows share one edge.
    expect(rowStyle).toMatchObject({ position: "absolute", top: 59 + 8, left: 16 });
    expect(row.props.pointerEvents).toBe("box-none");
    expect(button.type).toBe("MobileIconButton");
    expect(button.props).toMatchObject({ testID: "page-back", label: "t:parrot.nav.back" });
    // Only the dark round is the page's own: the size and shape stay the shared 48 dp ones.
    expect(buttonStyle).toMatchObject({ backgroundColor: "rgba(0,0,0,0.45)" });
    for (const key of ["width", "height", "borderRadius"]) expect(buttonStyle).not.toHaveProperty(key);
    (button.props.onPress as () => void)();
    expect(back).toBe(1);
  });

  it("starts the content below the status bar and the 48 dp button", () => {
    expect(usePageTop()).toBe(59 + PAGE_BACK_ROW);
    expect(PAGE_BACK_ROW).toBe(48 + 16);
  });

  it("@req UX-PHONE-13[parrot] the artist hero's back arrow is the shared icon button too, at the shared size", () => {
    const artist = source("src/screens/ArtistScreen.tsx");
    const back = artist.match(/<(\w+)\s+testID="page-back"/)?.[1];
    const round = artist.match(/heroRoundButton: \{[^}]*\}/)?.[0] ?? "";
    log("artist", { back, round });
    expect(back).toBe("MobileIconButton");
    expect(round).not.toMatch(/\b(width|height|borderRadius):/);
  });

  it("hides the navigator's header on every page; the pushed pages draw the button and pad their content by it", () => {
    const app = source("App.tsx");
    expect(app).toContain("screenOptions={{ headerShown: false }}");
    expect(app).not.toMatch(/headerShown: true/);
    for (const name of ["Album", "Artist", "Playlist", "PairDevice"]) {
      const page = source(`src/screens/${name}Screen.tsx`);
      log("page", { name, back: page.includes("<PageBackButton") });
      expect(page).toContain("<PageBackButton onPress={() => navigation.goBack()} />");
      // The artist page (PAR-LOOK-06) opens on its photo edge to edge, up behind the status bar, so its content does not
      // start below the back row: the hero draws its own round back button under the status bar instead.
      if (name === "Artist") expect(page).toMatch(/testID="page-back"[\s\S]*?\bback\b/);
      else expect(page).toMatch(/usePageTop\(\)/);
    }
  });
});
