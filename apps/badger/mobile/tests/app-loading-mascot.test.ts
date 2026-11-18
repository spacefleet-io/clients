/**
 * @test-id BADGER-MOBILE-LOADING-MASCOT-001
 * @level unit
 * @req UX-WAIT-02[badger-mobile]
 * @req UX-WAIT-02[badger-tv]
 * @why Chris (2026-11-11): the screens shown while the app opens ("Loading…") and while it opens the library ("Loading
 *   library…") get the hovering badger above their loading text, on the phone and the TV (the same binary); the text
 *   keeps its key and stays under the badger. The screen is called as a function against the shared react-native
 *   stand-ins, with translation keys standing for the texts; the navigator's source shows both waits use it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 7;
  };
  return { tv: false };
});
const log = (step: string, detail: unknown) => console.info(`[BADGER-MOBILE-LOADING-MASCOT-001] ${step}`, JSON.stringify(detail));

vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("../src/tv/lib/tvRuntime", () => ({
  get IS_TV() {
    return ctl.tv;
  },
}));
vi.mock("../src/theme/theme", () => {
  const anyKey = new Proxy({}, { get: () => "x" });
  return { theme: { colors: anyKey, spacing: anyKey } };
});

import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { AppLoadingScreen } from "../src/navigation/AppLoadingScreen";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const kids = (el: Element) => [el.props.children].flat() as Element[];

describe("the loading screens' badger (UX-WAIT-02)", () => {
  it("@req UX-WAIT-02 shows the hovering badger above the unchanged loading text on the phone", () => {
    ctl.tv = false;
    const screen = AppLoadingScreen({ label: "nav.loading" }) as unknown as Element;
    const [wrap] = kids(screen);
    const [mascot, text] = kids(wrap!);
    log("phone", { root: screen.type, order: kids(wrap!).map((el) => el.type === MobileMascotLoader ? "MobileMascotLoader" : el.type), mascot: mascot!.props, text: text!.props.children });
    expect(screen.type).toBe("SafeAreaView");
    expect(mascot!.type).toBe(MobileMascotLoader);
    expect(mascot!.props).toMatchObject({ app: "badger", source: 7, size: 120 });
    expect(text!.type).toBe("Text");
    expect(text!.props.children).toBe("nav.loading");
    expect(kids(wrap!)).toHaveLength(2);
  });

  it("@req UX-WAIT-02 draws the badger larger on the TV, over the same text", () => {
    ctl.tv = true;
    const [wrap] = kids(AppLoadingScreen({ label: "nav.loadingLibrary" }) as unknown as Element);
    const [mascot, text] = kids(wrap!);
    log("tv", { mascot: mascot!.props, text: text!.props.children });
    expect(mascot!.props).toMatchObject({ app: "badger", size: 180 });
    expect(text!.props.children).toBe("nav.loadingLibrary");
  });

  it("@req UX-WAIT-02 is the screen of both waits in the navigator, with their keys unchanged", () => {
    const navigator = readFileSync(join(__dirname, "../src/navigation/AppNavigator.tsx"), "utf8");
    const uses = [...navigator.matchAll(/<AppLoadingScreen label=\{t\("([\w.]+)"\)\} \/>/g)].map((m) => m[1]);
    log("navigator", uses);
    expect(uses).toEqual(["nav.loading", "nav.loadingLibrary"]);
  });
});
