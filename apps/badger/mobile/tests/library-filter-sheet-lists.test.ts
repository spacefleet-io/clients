// @req UX-LIST-01[badger-mobile]
// The media library "Sort & filter" sheet holds several options. Sort, order and "downloaded only" are short fixed
// choices and stay inline; genres and actors depend on the library, so each shows as one row with the current selection
// and opens its own scrolling sheet. The actor sheet keeps its full height whatever the number of matches and fits the
// space above the keyboard, so its title and search stay on screen.
// The filters go through the real reducer of the library screen.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { EMPTY_LIBRARY_FILTERS, DEFAULT_LIBRARY_VIEW_PREFS } from "@space/shared/libraryView";
import { LibraryFilterSheet, type LibraryFilterOption } from "../src/components/LibraryFilterSheet";
import { usePickerSheet } from "../src/components/usePickerSheet";
import { libraryFiltersReducer } from "../src/lib/libraryScreenState";
import { createFakeAsyncStorage } from "./harness";

// vi.mock factories are hoisted above every import, so they load what they need (React, the dictionary) themselves.

const fakeStorage = createFakeAsyncStorage();
/** Keyboard listeners the sheet registered; the tests play the keyboard events through them. */
type KeyboardListener = { name: string; listener: (event: { endCoordinates: { screenY: number; height: number } }) => void };
const keyboard = vi.hoisted(() => ({ listeners: new Set<KeyboardListener>() }));
/** The shared sheet's Animated.Value; a slide in this stand-in ends at once. */
const { FakeValue } = vi.hoisted(() => {
  class FakeValue {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.value = value;
    }
    stopAnimation() {}
    interpolate(config: unknown) {
      return { interpolation: config, source: this };
    }
  }
  return { FakeValue };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    ScrollView: "ScrollView",
    Pressable: "Pressable",
    Switch: "Switch",
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Keyboard: {
      addListener: (name: string, listener: KeyboardListener["listener"]) => {
        const entry = { name, listener };
        keyboard.listeners.add(entry);
        return { remove: () => keyboard.listeners.delete(entry) };
      },
    },
    // The real Modal only mounts its content while visible; so does this one.
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? React.createElement("Modal", null, children) : null,
    Animated: {
      View: "AnimatedView",
      Value: FakeValue,
      timing: (value: InstanceType<typeof FakeValue>, config: { toValue: number }) => ({
        start: (done?: (result: { finished: boolean }) => void) => {
          value.setValue(config.toValue);
          done?.({ finished: true });
        },
      }),
      spring: (value: InstanceType<typeof FakeValue>, config: { toValue: number }) => ({
        start: () => value.setValue(config.toValue),
      }),
    },
    Easing: { in: (f: unknown) => f, out: (f: unknown) => f, cubic: () => 0 },
  };
});
// The shared sheet's drags run in gesture-handler, which needs native code: these stand-ins render their children.
vi.mock("react-native-gesture-handler", async () => {
  const React = await import("react");
  const gesture = () => {
    const chain: Record<string, () => unknown> = {};
    for (const name of ["runOnJS", "enabled", "activeOffsetY", "failOffsetY", "failOffsetX", "onUpdate", "onEnd", "requireExternalGestureToFail"]) {
      chain[name] = () => chain;
    }
    return chain;
  };
  return {
    Gesture: { Pan: gesture, Native: gesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => React.createElement("View", null, children),
  };
});
// The sheet's crash boundary pulls in the error report and the app backdrop; these lists never throw, so it passes through.
vi.mock("@space/mobile-shell/render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/i18n", async () => {
  const enDict = (await import("../../../../packages/mobile-shell/src/i18n/en.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return { translate, getCurrentLanguage: () => "en", useTranslation: () => ({ t: translate }) };
});
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover" }));
vi.mock("@space/mobile-shell/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  const theme = { colors, font: { family: {} } };
  // src/theme/theme.ts builds Badger's shell theme with mergeMobileShellTheme since #1447 (UX-SKY-03).
  return { defaultMobileShellTheme: theme, mergeMobileShellTheme: () => theme, useMobileShellTheme: () => ({ colors }) };
});
vi.mock("lucide-react-native", () => ({ Check: () => null, ChevronRight: () => null }));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/components/Panel", () => ({ panelCardStyle: {} }));

const GENRES: LibraryFilterOption[] = Array.from({ length: 16 }, (_, index) => ({
  value: `movie:${index + 1}`,
  label: `Genre ${String(index + 1).padStart(2, "0")}`,
}));
const ACTORS = Array.from({ length: 40 }, (_, index) => `Actor ${String(index).padStart(2, "0")}`);

/** The library screen's wiring: an open filter sheet whose filters run through the real reducer. */
const Host = ({ actorNames }: { actorNames: readonly string[] | null }) => {
  const sheet = usePickerSheet();
  const [filters, dispatch] = React.useReducer(libraryFiltersReducer, { ...EMPTY_LIBRARY_FILTERS, genres: ["movie:3"] });
  const { open } = sheet;
  React.useEffect(() => open(), [open]);
  return React.createElement(LibraryFilterSheet, {
    sheet,
    prefs: DEFAULT_LIBRARY_VIEW_PREFS.movie,
    onChangePrefs: () => undefined,
    filters,
    dispatch,
    genreOptions: GENRES,
    actorNames,
  });
};

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

const root = (): ReactTestInstance => {
  if (!renderer) throw new Error("nothing mounted");
  return renderer.root;
};
const hostNodes = (scope: ReactTestInstance, match: (node: ReactTestInstance) => boolean) =>
  scope.findAll((node) => typeof node.type === "string" && match(node));
const byTestID = (testID: string) => {
  const [node] = hostNodes(root(), (candidate) => candidate.props.testID === testID);
  if (!node) throw new Error(`no node with testID ${testID}`);
  return node;
};
const byRole = (scope: ReactTestInstance, role: string) => hostNodes(scope, (node) => node.props.accessibilityRole === role);
const labels = (nodes: ReactTestInstance[]) => nodes.map((node) => String(node.props.accessibilityLabel));
const checked = (scope: ReactTestInstance) => labels(byRole(scope, "checkbox").filter((node) => node.props.accessibilityState?.checked));
const press = async (node: ReactTestInstance) => {
  await act(async () => {
    node.props.onPress();
  });
};

const flatStyle = (testID: string) => Object.assign({}, ...[byTestID(testID).props.style].flat());
/** The sheet's own height limits (the BottomSheet's style array flattened), to check what its layout depends on. */
const sheetSize = (testID: string): { height?: number; maxHeight?: number } => {
  const style = flatStyle(testID);
  return { height: style.height, maxHeight: style.maxHeight };
};
const searchActors = async (text: string) => {
  const [search] = hostNodes(byTestID("library-actors-sheet"), (node) => String(node.type) === "TextInput");
  if (!search) throw new Error("actor search missing");
  await act(async () => {
    search.props.onChangeText(text);
  });
};
const WINDOW_HEIGHT = 800;
const KEYBOARD_HEIGHT = 300;
const KEYBOARD_TOP = WINDOW_HEIGHT - KEYBOARD_HEIGHT;
const keyboardEvent = async (name: string, screenY: number) => {
  await act(async () => {
    keyboard.listeners.forEach((entry) => {
      if (entry.name === name) entry.listener({ endCoordinates: { screenY, height: WINDOW_HEIGHT - screenY } });
    });
  });
};
/** Where the actor sheet sits in its overlay: the sheet is laid out at the bottom, above the overlay's bottom padding. */
const actorSheetFrame = (overlayHeight: number) => {
  const height = Number(flatStyle("library-actors-sheet").height);
  const bottomPadding = Number(flatStyle("library-actors-sheet-overlay").paddingBottom ?? 0);
  return { height, bottomPadding, top: overlayHeight - bottomPadding - height };
};
const openActorSheetWithManyMatches = async () => {
  await mount(ACTORS);
  await press(byTestID("library-actors"));
  await searchActors("actor");
  expect(byRole(byTestID("library-actors-sheet"), "checkbox")).toHaveLength(30);
};

const mount = async (actorNames: readonly string[] | null) => {
  await act(async () => {
    renderer = create(React.createElement(Host, { actorNames }));
  });
};

describe("library Sort & filter sheet (UX-LIST-01)", () => {
  it("genres are one row with the current selection; the genre list opens in its own scrolling sheet", async () => {
    await mount(ACTORS);
    console.log("filter sheet", { buttons: labels(byRole(root(), "button")), radios: labels(byRole(root(), "radio")) });
    expect(byRole(root(), "checkbox"), "no genre or actor chip inline").toHaveLength(0);
    expect(labels(byRole(root(), "radio")), "sort and order stay inline").toEqual([
      "Name",
      "Date added",
      "Release year",
      "Ascending",
      "Descending",
    ]);
    expect(labels(byRole(root(), "switch"))).toEqual(["Downloaded only"]);
    expect(byTestID("library-genres").props.accessibilityLabel).toBe("Genres: Genre 03");

    await press(byTestID("library-genres"));
    const sheet = byTestID("library-genres-sheet");
    console.log("genre sheet", { options: labels(byRole(sheet, "checkbox")), checked: checked(sheet) });
    expect(hostNodes(sheet, (node) => String(node.type) === "ScrollView"), "the list scrolls on its own").toHaveLength(1);
    expect(labels(byRole(sheet, "checkbox"))).toEqual(GENRES.map((genre) => genre.label));
    expect(checked(sheet)).toEqual(["Genre 03"]);

    const genre05 = byRole(sheet, "checkbox").find((node) => node.props.accessibilityLabel === "Genre 05");
    if (!genre05) throw new Error("Genre 05 missing");
    await press(genre05);
    const after = byTestID("library-genres-sheet");
    console.log("after toggle", { checked: checked(after), row: byTestID("library-genres").props.accessibilityLabel });
    expect(checked(after), "several genres can be picked; the sheet stays open").toEqual(["Genre 03", "Genre 05"]);
    expect(byTestID("library-genres").props.accessibilityLabel).toBe("Genres: Genre 03, Genre 05");
    expect(sheetSize("library-genres-sheet"), "a list without a search fits its content").toEqual({ maxHeight: 800 * 0.88 });
  });

  it("actors are one row; their sheet holds the search and a scrolling list of matches", async () => {
    await mount(ACTORS);
    expect(byTestID("library-actors").props.accessibilityLabel).toBe("Actors: All actors");
    expect(hostNodes(root(), (node) => String(node.type) === "TextInput"), "the actor search lives in the actor sheet").toHaveLength(0);

    await press(byTestID("library-actors"));
    const sheet = byTestID("library-actors-sheet");
    expect(hostNodes(sheet, (node) => String(node.type) === "ScrollView")).toHaveLength(1);
    expect(byRole(sheet, "checkbox"), "the most frequent actors before typing").toHaveLength(12);
    const fullSize = sheetSize("library-actors-sheet");
    console.log("actor sheet size before typing", fullSize);
    expect(fullSize, "the actor sheet starts at its full height").toEqual({ height: 800 * 0.88 });

    await searchActors("actor 3");
    const matches = labels(byRole(byTestID("library-actors-sheet"), "checkbox"));
    console.log("actor matches", matches);
    expect(matches).toEqual(ACTORS.filter((name) => name.startsWith("Actor 3")));

    const actor31 = byRole(byTestID("library-actors-sheet"), "checkbox").find((node) => node.props.accessibilityLabel === "Actor 31");
    if (!actor31) throw new Error("Actor 31 missing");
    await press(actor31);
    expect(byTestID("library-actors").props.accessibilityLabel).toBe("Actors: Actor 31");

    // A search that matches nobody: the picked actor stays listed and ticked, and the sheet keeps its full height so
    // the search field at its top never slides under the keyboard.
    await searchActors("nobody");
    const narrowed = byTestID("library-actors-sheet");
    console.log("actor sheet after a search with no match", { options: labels(byRole(narrowed, "checkbox")), size: sheetSize("library-actors-sheet") });
    expect(labels(byRole(narrowed, "checkbox"))).toEqual(["Actor 31"]);
    expect(checked(narrowed)).toEqual(["Actor 31"]);
    expect(sheetSize("library-actors-sheet"), "the sheet height does not depend on the number of results").toEqual(fullSize);
  });

  // A keyboard covers the bottom of the screen. Whether the system shrinks the modal above it (Android) or not (iOS),
  // the actor sheet must fit the space above the keyboard: its title and search stay on screen, only its list shrinks.
  it("with the keyboard up and the modal not resized (iOS), the actor sheet fits above the keyboard", async () => {
    await openActorSheetWithManyMatches();
    await keyboardEvent("keyboardWillShow", KEYBOARD_TOP);
    const frame = actorSheetFrame(WINDOW_HEIGHT);
    console.log("actor sheet, keyboard up, modal not resized", frame);
    expect(frame.bottomPadding, "the sheet sits on the keyboard, not behind it").toBe(KEYBOARD_HEIGHT);
    expect(frame.height + KEYBOARD_HEIGHT).toBeLessThanOrEqual(WINDOW_HEIGHT);
    expect(frame.top, "the sheet's title and search stay inside the screen").toBeGreaterThanOrEqual(0);
    expect(hostNodes(byTestID("library-actors-sheet"), (node) => String(node.type) === "TextInput")).toHaveLength(1);

    await keyboardEvent("keyboardWillHide", WINDOW_HEIGHT);
    console.log("actor sheet, keyboard down", actorSheetFrame(WINDOW_HEIGHT));
    expect(actorSheetFrame(WINDOW_HEIGHT), "the sheet takes its full height back").toEqual({
      height: WINDOW_HEIGHT * 0.88,
      bottomPadding: 0,
      top: WINDOW_HEIGHT * 0.12,
    });
  });

  it("with the keyboard up and the modal resized above it (Android), the actor sheet fits the smaller modal", async () => {
    await openActorSheetWithManyMatches();
    await act(async () => {
      byTestID("library-actors-sheet-overlay").props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: KEYBOARD_TOP } } });
    });
    const resized = actorSheetFrame(KEYBOARD_TOP);
    console.log("actor sheet, modal resized, no keyboard event", resized);
    expect(resized.top, "the title and search stay inside the resized modal").toBeGreaterThanOrEqual(0);
    expect(resized.height + KEYBOARD_HEIGHT).toBeLessThanOrEqual(WINDOW_HEIGHT);

    await keyboardEvent("keyboardDidShow", KEYBOARD_TOP);
    console.log("actor sheet, modal resized, keyboard event", actorSheetFrame(KEYBOARD_TOP));
    expect(actorSheetFrame(KEYBOARD_TOP), "the keyboard is not counted twice").toEqual(resized);
    expect(resized.bottomPadding).toBe(0);
  });

  it("while the actors load, the actor sheet says so instead of a list", async () => {
    await mount(null);
    await press(byTestID("library-actors"));
    const sheet = byTestID("library-actors-sheet");
    expect(byRole(sheet, "checkbox")).toHaveLength(0);
    expect(hostNodes(sheet, (node) => String(node.type) === "Text").map((node) => node.props.children)).toContain("Loading actors…");
  });
});
