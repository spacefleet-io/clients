/**
 * TV-UI-PRIMITIVES-001 (UX-TV-34, UX-TV-35): the shared TV look of the approved redesign (Chris 2026-11-12 (chat)):
 * the amber focus ring with a gap (inside the edge for rows that span a list), the pill buttons, the chips and the
 * segmented control, the settings row and the eyebrow label. Rendered with react-test-renderer: react-native is replaced
 * by host-element stand-ins, and each Pressable's style callback is read with and without the remote's focus.
 *
 * @req UX-TV-34[badger-tv]
 * @req UX-TV-35[badger-tv]
 * @req UX-A11Y-04[badger-tv]
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LucideIcon } from "lucide-react-native";
import { TvFocusable } from "../components/TvFocusable";
import { TvChip, TvSegmented } from "./TvChip";
import { TvIconButton, TvPillButton } from "./TvPillButton";
import { TvRow, TvRowList } from "./TvRow";
import { TvEyebrow } from "./TvText";
import { TV_COLOR, TV_FOCUS, TV_RADII } from "./tokens";

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("lucide-react-native", () => ({ ChevronRight: "ChevronIcon" }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover" }));
vi.mock("../../theme/theme", () => ({
  theme: {
    colors: { bg: "#000", surface: "#111", surfaceRaised: "#222", border: "#333", accent: "#ffb357", text: "#fff", textMuted: "#888", danger: "#f00" },
    accentTextHex: "#1a1300",
    font: { family: { sans: "Inter", display: "SpaceGrotesk" } },
  },
}));

const PlayIcon = "PlayIcon" as unknown as LucideIcon;
const NextIcon = "NextIcon" as unknown as LucideIcon;
const GearIcon = "GearIcon" as unknown as LucideIcon;

const render = (element: React.ReactElement): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const pressables = (tree: ReactTestRenderer) => tree.root.findAll(isType("Pressable"));
/** The Pressable's style as react-native-tvos draws it, with or without the remote's focus. */
const styleOf = (pressable: ReactTestInstance, focused: boolean) => flat(pressable.props.style({ focused, pressed: false }));

describe("the focus ring (TV-UI-PRIMITIVES-001)", () => {
  it("@req UX-TV-35 @req UX-A11Y-04 draws an amber outline with a gap outside the element and lifts it, only while focused", () => {
    const [pressable] = pressables(render(<TvFocusable onPress={() => undefined} />));
    const idle = styleOf(pressable, false);
    const focused = styleOf(pressable, true);
    console.info("[TV-UI-PRIMITIVES-001] ring", JSON.stringify({ idle, focused }));
    expect(idle.outlineWidth).toBeUndefined();
    expect(idle.transform).toBeUndefined();
    expect(focused.outlineColor).toBe(TV_COLOR.amber);
    expect(focused.outlineWidth).toBe(TV_FOCUS.width);
    expect(focused.outlineOffset).toBe(TV_FOCUS.offset);
    expect(focused.transform).toEqual([{ scale: TV_FOCUS.scale }]);
    // An outline takes no room, so the focus arriving never moves anything: no border or margin is added.
    expect(focused.borderWidth).toBe(idle.borderWidth);
    expect(focused.margin).toBe(idle.margin);
  });

  it("@req UX-TV-35 draws the ring inside the edge for a row that spans its list, or not at all when the element draws its own", () => {
    const [inside] = pressables(render(<TvFocusable ring="inside" scale={1} />));
    const [none] = pressables(render(<TvFocusable ring="none" scale={1} />));
    expect(styleOf(inside, true).outlineOffset).toBe(-TV_FOCUS.width);
    expect(styleOf(inside, true).transform).toBeUndefined();
    expect(styleOf(none, true).outlineWidth).toBeUndefined();
  });

  it("@req UX-TV-35 turns Apple's own focus effect off, so every TV shows the same ring", () => {
    const [pressable] = pressables(render(<TvFocusable />));
    expect(pressable.props.tvParallaxProperties).toEqual({ enabled: false });
  });
});

describe("pill buttons (TV-UI-PRIMITIVES-001)", () => {
  it("@req UX-TV-34 the primary button is the amber pill with dark text; the secondary one a dark pill with a thin border", () => {
    const tree = render(
      <>
        <TvPillButton label="Play" icon={PlayIcon} filledIcon variant="primary" testID="primary" />
        <TvPillButton label="Trailer" icon={PlayIcon} testID="secondary" />
      </>,
    );
    const [primary, secondary] = pressables(tree);
    const p = styleOf(primary, false);
    const s = styleOf(secondary, false);
    console.info("[TV-UI-PRIMITIVES-001] pills", JSON.stringify({ p, s }));
    expect(p.borderRadius).toBe(TV_RADII.pill);
    expect(s.borderRadius).toBe(TV_RADII.pill);
    expect(p.backgroundColor).toBe(TV_COLOR.amber);
    expect(s.backgroundColor).not.toBe(TV_COLOR.amber);
    expect(Number(s.borderWidth)).toBeGreaterThan(0);
    expect(flat(primary.find(isType("Text")).props.style).color).toBe(TV_COLOR.onAmber);
    expect(flat(secondary.find(isType("Text")).props.style).color).toBe(TV_COLOR.text);
    // The play icon is drawn filled on request, in the label's colour.
    expect(primary.find(isType("PlayIcon")).props.fill).toBe(TV_COLOR.onAmber);
    expect(secondary.find(isType("PlayIcon")).props.fill).toBe("none");
    expect(primary.props.accessibilityLabel).toBe("Play");
    // The ring sits outside the amber pill with a gap, so it shows on amber too.
    expect(Number(styleOf(primary, true).outlineOffset)).toBeGreaterThan(0);
  });

  it("@req UX-TV-34 an icon before the label and one after it (Next ›) keep that order", () => {
    const [button] = pressables(render(<TvPillButton label="Next" icon={PlayIcon} iconEnd={NextIcon} />));
    const order = button.children.map((c) => (typeof c === "string" ? c : String(c.type)));
    expect(order).toEqual(["PlayIcon", "Text", "NextIcon"]);
  });

  it("@req UX-TV-34 an icon button shows no text, is named for the screen reader, and the open one has an amber icon", () => {
    const tree = render(
      <>
        <TvIconButton icon={GearIcon} accessibilityLabel="Settings" />
        <TvIconButton icon={GearIcon} accessibilityLabel="Settings" selected />
      </>,
    );
    const [plain, open] = pressables(tree);
    expect(plain.findAll(isType("Text"))).toHaveLength(0);
    expect(plain.props.accessibilityLabel).toBe("Settings");
    expect(open.find(isType("GearIcon")).props.color).toBe(TV_COLOR.amber);
    expect(plain.find(isType("GearIcon")).props.color).toBe(TV_COLOR.text);
  });
});

describe("chips and the segmented control (TV-UI-PRIMITIVES-001)", () => {
  it("@req UX-TV-34 a chip is a pill; the chosen one is amber and announced as selected", () => {
    const tree = render(
      <>
        <TvChip label="A to Z" />
        <TvChip label="Recently added" selected iconEnd={NextIcon} />
      </>,
    );
    const [plain, chosen] = pressables(tree);
    expect(styleOf(plain, false).borderRadius).toBe(TV_RADII.pill);
    expect(styleOf(chosen, false).backgroundColor).toBe(TV_COLOR.amber);
    expect(styleOf(plain, false).backgroundColor).not.toBe(TV_COLOR.amber);
    expect(chosen.props.accessibilityState).toEqual({ selected: true });
    expect(plain.props.accessibilityState).toEqual({ selected: false });
    expect(chosen.find(isType("NextIcon")).props.color).toBe(TV_COLOR.onAmber);
  });

  it("@req UX-TV-34 the segmented control is a radio group: OK on a choice picks it, the chosen one is checked and amber", () => {
    const onChange = vi.fn();
    const onFocusOption = vi.fn();
    const options = [
      { value: "movie", label: "Films" },
      { value: "tv", label: "Series" },
    ] as const;
    const tree = render(<TvSegmented options={options} value="movie" onChange={onChange} testID="kind" preferredValue="tv" onFocusOption={onFocusOption} />);
    const tray = tree.root.find((n) => isType("View")(n) && n.props.testID === "kind");
    expect(tray.props.accessibilityRole).toBe("radiogroup");
    const [films, series] = pressables(tree);
    expect([films.props.testID, series.props.testID]).toEqual(["kind-movie", "kind-tv"]);
    expect(films.props.accessibilityRole).toBe("radio");
    expect(films.props.accessibilityState).toEqual({ checked: true });
    expect(series.props.accessibilityState).toEqual({ checked: false });
    expect(styleOf(films, false).backgroundColor).toBe(TV_COLOR.amber);
    expect(styleOf(series, false).backgroundColor).not.toBe(TV_COLOR.amber);
    // The remote starts on the preferred choice.
    expect(series.props.hasTVPreferredFocus).toBe(true);
    expect(films.props.hasTVPreferredFocus).toBe(false);
    act(() => series.props.onFocus());
    expect(onFocusOption).toHaveBeenCalledWith("tv");
    act(() => series.props.onPress());
    expect(onChange).toHaveBeenCalledWith("tv");
  });
});

describe("settings rows (TV-UI-PRIMITIVES-001)", () => {
  it("@req UX-TV-34 a toggle row is a switch with its state; the ring sits inside the row, which does not grow", () => {
    const tree = render(<TvRow icon={GearIcon} title="Error reports" description="Send crash reports" end={{ kind: "toggle", value: true }} />);
    const [row] = pressables(tree);
    expect(row.props.accessibilityRole).toBe("switch");
    expect(row.props.accessibilityState).toEqual({ checked: true });
    expect(row.props.accessibilityHint).toBe("Send crash reports");
    expect(tree.root.findAll((n) => n.props.testID === "tv-toggle-on")).toHaveLength(1);
    expect(tree.root.findAll((n) => n.props.testID === "tv-row-icon")).toHaveLength(1);
    const focused = styleOf(row, true);
    expect(focused.outlineOffset).toBe(-TV_FOCUS.width);
    expect(focused.transform).toBeUndefined();
    expect(focused.backgroundColor).toBe(TV_COLOR.amberTint);
  });

  it("@req UX-TV-34 a value row reads its title and value, shows the value with an arrow; a danger row has a red title", () => {
    const tree = render(
      <TvRowList testID="list">
        <TvRow title="Quality" end={{ kind: "value", value: "Auto" }} />
        <TvRow title="Sign out" danger end={{ kind: "none" }} />
      </TvRowList>,
    );
    const [quality, signOut] = pressables(tree);
    expect(quality.props.accessibilityRole).toBe("button");
    expect(quality.props.accessibilityLabel).toBe("Quality, Auto");
    expect(quality.findAll(isType("Text")).map((t) => t.props.children)).toEqual(["Quality", "Auto"]);
    expect(quality.findAll(isType("ChevronIcon"))).toHaveLength(1);
    expect(signOut.findAll(isType("ChevronIcon"))).toHaveLength(0);
    expect(flat(signOut.find(isType("Text")).props.style).color).toBe(TV_COLOR.danger);
    // The list is one rounded card with a thin line between its rows.
    const list = tree.root.find((n) => isType("SkyCover")(n) && n.props.testID === "list");
    expect(flat(list.props.style).borderRadius).toBe(TV_RADII.card);
    expect(list.children.filter((c) => typeof c !== "string" && isType("View")(c))).toHaveLength(1);
  });
});

describe("the eyebrow (TV-UI-PRIMITIVES-001)", () => {
  it("@req UX-TV-34 is amber spaced capitals over a title, grey over a group of settings", () => {
    const tree = render(
      <>
        <TvEyebrow>Continue watching</TvEyebrow>
        <TvEyebrow tone="muted">Quality and languages</TvEyebrow>
      </>,
    );
    const [amber, muted] = tree.root.findAll(isType("Text")).map((t) => flat(t.props.style));
    expect(amber.textTransform).toBe("uppercase");
    expect(Number(amber.letterSpacing)).toBeGreaterThan(0);
    expect(amber.color).toBe(TV_COLOR.amber);
    expect(muted.color).toBe(TV_COLOR.muted);
    expect(muted.textTransform).toBe("uppercase");
  });
});
