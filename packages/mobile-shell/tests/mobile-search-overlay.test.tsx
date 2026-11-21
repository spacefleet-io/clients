/**
 * @test-id MOBILE-SEARCH-OVERLAY-001
 * @level component
 * @req UX-PHONE-12[badger-mobile,parrot]
 * @why Chris, 2026-11-19: "When clicked the button opens a search in the middle of the screen like the global search
 *   feature of the desktop apps. It autocompletes as the user types, fusy searches, etc." The shared search card: the
 *   field takes the keyboard at once, a hint shows until something is typed, results come per group as the user types
 *   (typos included), a group shows its best five and "N more" opens the rest, nothing found says so, a tapped result
 *   closes the card and goes to it, and the backdrop or the X closes it.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const focus = vi.hoisted(() => ({ calls: 0, blurs: 0 }));
const device = vi.hoisted(() => ({ os: "android", keyboardUp: true }));

vi.mock("react-native", async () => {
  // vi.mock factories are hoisted above the static imports, so React is loaded inside the factory.
  const ReactModule = await import("react");
  const TextInput = ReactModule.forwardRef((props: Record<string, unknown>, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ focus: () => void (focus.calls += 1), blur: () => void (focus.blurs += 1) }));
    return ReactModule.createElement("TextInput", props);
  });
  const Pressable = ({ style, children, ...props }: Record<string, unknown>) =>
    ReactModule.createElement("Pressable", { ...props, style: typeof style === "function" ? style({ pressed: false }) : style }, children as React.ReactNode);
  return {
    Keyboard: { isVisible: () => device.keyboardUp },
    Platform: {
      get OS() {
        return device.os;
      },
    },
    Modal: "Modal",
    Pressable,
    ScrollView: "ScrollView",
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
    Text: "Text",
    TextInput,
    View: "View",
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock("lucide-react-native", () => ({ Search: "Icon:Search", X: "Icon:X" }));
vi.mock("../src/keyboard", () => ({ useKeyboardInset: () => 300 }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#40dd8f", text: "#fff", textMuted: "#b6bace", textDim: "#555", surface: "#111", surfaceRaised: "#222", border: "#333" },
    radius: { lg: 16 },
    font: { family: { sans: "Inter" } },
  }),
}));

import { createFuzzyIndex } from "@space/shared/fuzzySearch";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";
import {
  MOBILE_SEARCH_KEYBOARD_ASKS,
  MOBILE_SEARCH_KEYBOARD_FIRST_RETRY_MS,
  MOBILE_SEARCH_KEYBOARD_RETRY_MS,
  MOBILE_SEARCH_PER_GROUP,
  MobileSearchOverlay,
} from "../src/components/mobile-search-overlay";

const log = (step: string, detail: unknown) => console.info(`[MOBILE-SEARCH-OVERLAY-001] ${step}`, JSON.stringify(detail));

type Song = { id: string; title: string; artist: string };
const artists = ["Linnet", "Nova", "Bérénice"];
const songs: Song[] = [
  { id: "s-lp", title: "Linnet Park", artist: "Nova" },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `s-park-${i}`, title: `Park Song ${i + 1}`, artist: "Linnet" })),
];
type Item = { kind: "artist"; name: string } | { kind: "song"; song: Song };
const groups = [
  { id: "artists", index: createFuzzyIndex<Item>(artists.map((name) => ({ kind: "artist", name })), (item) => (item.kind === "artist" ? [item.name] : [])) },
  { id: "songs", index: createFuzzyIndex<Item>(songs.map((song) => ({ kind: "song", song })), (item) => (item.kind === "song" ? [item.song.title, item.song.artist] : [])) },
];
const strings = phoneSearchStrings("parrot", "en");

let renderer: ReactTestRenderer | null = null;
const events: string[] = [];
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  events.length = 0;
  focus.calls = 0;
  focus.blurs = 0;
  device.os = "android";
  device.keyboardUp = true;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

const render = async (visible = true) => {
  await act(async () => {
    renderer = create(
      <MobileSearchOverlay<Item>
        visible={visible}
        onClose={() => events.push("close")}
        strings={strings}
        groups={groups}
        describe={(item) => (item.kind === "artist" ? { key: item.name, title: item.name } : { key: item.song.id, title: item.song.title, subtitle: item.song.artist })}
        onSelect={(item, group) => events.push(`select:${group}:${item.kind === "artist" ? item.name : item.song.id}`)}
      />
    );
  });
  return renderer!;
};
const byId = (tree: ReactTestRenderer, id: string) => tree.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
const testIds = (tree: ReactTestRenderer, prefix: string) =>
  tree.root.findAll((node) => typeof node.type === "string" && String(node.props.testID ?? "").startsWith(prefix)).map((node) => String(node.props.testID));
const textOf = (node: ReactTestInstance) => node.findAll((child) => String(child.type) === "Text").map((child) => child.props.children).join(" ");
const type = async (tree: ReactTestRenderer, text: string) => {
  await act(async () => byId(tree, "search-overlay-input")[0]!.props.onChangeText(text));
};

describe("MobileSearchOverlay (UX-PHONE-12)", () => {
  it("opens with the field focused and the hint, above the keyboard", async () => {
    const tree = await render();
    const modal = tree.root.findByType("Modal" as never);
    await act(async () => modal.props.onShow());
    const input = byId(tree, "search-overlay-input")[0]!;
    const layer = modal.findAll((node) => String(node.type) === "View")[0]!;
    log("open", { focus: focus.calls, placeholder: input.props.placeholder, message: textOf(byId(tree, "search-overlay-message")[0]!), layer: layer.props.style });
    expect(modal.props).toMatchObject({ visible: true, transparent: true });
    expect(focus.calls).toBe(1);
    expect(input.props.placeholder).toBe(strings.placeholder);
    expect(textOf(byId(tree, "search-overlay-message")[0]!)).toBe(strings.hint);
    expect(testIds(tree, "search-group-")).toEqual([]);
    expect(JSON.stringify(layer.props.style)).toContain('"paddingBottom":316');
  });

  // Chris, 2026-11-20: "When I click search and it opens (in both apps) the keyboard doesn't automatically open with
  // it, I have to click the search input first." Android refuses a keyboard asked for before the card's window has
  // focus, so the card asks again until the keyboard is up; iOS asks once (a re-ask would bounce its keyboard).
  it("on Android asks for the keyboard again until it is up; on iOS asks once", async () => {
    vi.useFakeTimers();
    device.keyboardUp = false;
    const android = await render();
    await act(async () => android.root.findByType("Modal" as never).props.onShow());
    await act(async () => void vi.advanceTimersByTime(MOBILE_SEARCH_KEYBOARD_FIRST_RETRY_MS));
    log("android refused once", { focus: focus.calls, blurs: focus.blurs });
    expect(focus).toMatchObject({ calls: 2, blurs: 1 });
    device.keyboardUp = true;
    await act(async () => void vi.advanceTimersByTime(MOBILE_SEARCH_KEYBOARD_RETRY_MS * MOBILE_SEARCH_KEYBOARD_ASKS));
    log("android keyboard up", { focus: focus.calls, blurs: focus.blurs });
    expect(focus).toMatchObject({ calls: 2, blurs: 1 });
    await act(async () => android.unmount());

    focus.calls = 0;
    focus.blurs = 0;
    device.os = "ios";
    device.keyboardUp = false;
    const ios = await render();
    await act(async () => ios.root.findByType("Modal" as never).props.onShow());
    await act(async () => void vi.advanceTimersByTime(MOBILE_SEARCH_KEYBOARD_RETRY_MS * MOBILE_SEARCH_KEYBOARD_ASKS));
    log("ios", { focus: focus.calls, blurs: focus.blurs });
    expect(focus).toMatchObject({ calls: 1, blurs: 0 });
  });

  it("answers as the user types, with a typo, in groups: the best five, then N more opens the rest", async () => {
    const tree = await render();
    await type(tree, "linet");
    const groupIds = testIds(tree, "search-group-");
    const songRows = testIds(tree, "search-result-songs-");
    log("linet", { groupIds, songRows, more: byId(tree, "search-more-songs").map(textOf) });
    expect(groupIds).toEqual(["search-group-artists", "search-group-songs"]);
    expect(textOf(byId(tree, "search-result-artists-0")[0]!)).toContain("Linnet");
    expect(songRows).toHaveLength(MOBILE_SEARCH_PER_GROUP);
    expect(textOf(byId(tree, "search-result-songs-0")[0]!)).toContain("Linnet Park");
    expect(textOf(byId(tree, "search-more-songs")[0]!)).toBe("4 more");
    await act(async () => byId(tree, "search-more-songs")[0]!.props.onPress());
    log("opened", { songRows: testIds(tree, "search-result-songs-").length });
    expect(testIds(tree, "search-result-songs-")).toHaveLength(9);
    expect(byId(tree, "search-more-songs")).toHaveLength(0);
  });

  it("says nothing was found, and the clear button empties the field", async () => {
    const tree = await render();
    await type(tree, "qqqqzz");
    log("none", { message: byId(tree, "search-overlay-message").map(textOf) });
    expect(textOf(byId(tree, "search-overlay-message")[0]!)).toBe(strings.empty);
    await act(async () => byId(tree, "search-overlay-clear")[0]!.props.onPress());
    expect(byId(tree, "search-overlay-input")[0]!.props.value).toBe("");
    expect(textOf(byId(tree, "search-overlay-message")[0]!)).toBe(strings.hint);
  });

  it("a tapped result closes the card and goes to it; the backdrop and the X close it", async () => {
    const tree = await render();
    await type(tree, "nova");
    await act(async () => byId(tree, "search-result-artists-0")[0]!.props.onPress());
    await act(async () => byId(tree, "search-overlay-backdrop")[0]!.props.onPress());
    await type(tree, "");
    await act(async () => byId(tree, "search-overlay-close")[0]!.props.onPress());
    log("events", events);
    expect(events).toEqual(["close", "select:artists:Nova", "close", "close"]);
  });
});
