/**
 * @test-id MOBILE-SHELL-LIBRARY-KEY-WORDS-RENDERS-001
 * @level unit
 * @bugfix @regression-proof
 * @why Walk of Badger phone on a OnePlus 6 test phone (2026-11-12): typing or clearing the 12 key-word boxes froze the phone for up to
 *   1.1 s. Every keystroke re-rendered all 12 boxes and read each box's word against every word list again. A keystroke
 *   now re-renders only the box it changes (and any box whose state it changes); the other boxes stay as they are.
 *   Functional check only: render counts, no timing.
 * @req UX-KEY-01[badger-mobile,parrot]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("react-native", async () => {
  // vi.mock factories run before the file's imports: React is loaded here, not taken from the import above.
  const { createElement } = await import("react");
  /** A TextInput that counts its renders by testID. */
  const TextInput = (props: { testID?: string } & Record<string, unknown>) => {
    const id = String(props.testID ?? "");
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return createElement("TextInput", props);
  };
  return {
    Clipboard: { setString: () => undefined },
    Platform: { isTV: false, OS: "android" },
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: "Text",
    TextInput,
    View: "View",
  };
});
vi.mock("../src/components/mobile-button-face", () => ({ MobileButtonFace: "MobileButtonFace" }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: () => undefined }) }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#f4a261", text: "#fff", textMuted: "#999", controlBorder: "#333", surfaceRaised: "#222", danger: "#e00", success: "#0c0" },
    accentTextHex: "#000",
  }),
}));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: "en" },
  }),
}));

import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import { LibraryKeyWordsInput } from "../src/libraryKeyWords";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-KEY-WORDS-RENDERS-001]";
const key = generateLibraryKeyWords("en", (bytes) => bytes.set(Array.from({ length: bytes.length }, (_, i) => i * 17)));

let tree: ReactTestRenderer | null = null;

const mount = () => {
  act(() => {
    tree = create(<LibraryKeyWordsInput onChangeText={() => undefined} onSubmitEditing={() => undefined} />, {
      createNodeMock: () => ({ focus: () => undefined, setSelection: () => undefined }),
    });
  });
};
const box = (n: number): ReactTestInstance =>
  tree!.root.find((node) => String(node.type) === "TextInput" && node.props.testID === `library-key-word-${n}`);
const shown = (n: number) => String(box(n).props.value).replace(/\u200B/g, "");
/** Renders of each box since the last reset, box 1 first. */
const counts = () => Array.from({ length: 12 }, (_, i) => renders.get(`library-key-word-${i + 1}`) ?? 0);
const typeLetter = (n: number, letter: string) => act(() => box(n).props.onChangeText(`${shown(n)}${letter}`));

beforeEach(() => renders.clear());
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe("LibraryKeyWordsInput re-renders only the box a keystroke changes", () => {
  it("typing letters into box 3 renders box 3 and leaves the other 11 alone", () => {
    mount();
    act(() => box(3).props.onFocus());
    renders.clear();
    const word = key.words[2];
    // All but the last letter: the box is still being typed in (a whole word would move on to box 4).
    for (const letter of word.slice(0, 3)) typeLetter(3, letter);
    console.info(SUITE, "after 3 letters", JSON.stringify({ shown: shown(3), counts: counts() }));
    expect(shown(3)).toBe(word.slice(0, 3));
    const after = counts();
    expect(after[2]).toBe(3);
    expect(after.filter((_, i) => i !== 2)).toEqual(Array(11).fill(0));
  });

  it("deleting a letter in a filled box renders that box only", () => {
    mount();
    act(() => box(5).props.onFocus());
    for (const letter of "abc") typeLetter(5, letter);
    renders.clear();
    act(() => box(5).props.onChangeText("ab"));
    console.info(SUITE, "after delete", JSON.stringify({ shown: shown(5), counts: counts() }));
    expect(shown(5)).toBe("ab");
    expect(counts()).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("a whole word moves on to the next box: only those two boxes render", () => {
    mount();
    act(() => box(1).props.onFocus());
    renders.clear();
    act(() => box(1).props.onChangeText(`${key.words[0]} `));
    // The keyboard's focus lands on box 2 (the ref's focus is a no-op here, so report it as the phone does).
    act(() => box(2).props.onFocus());
    console.info(SUITE, "after word + space", JSON.stringify({ shown: [shown(1), shown(2)], counts: counts() }));
    expect(shown(1)).toBe(key.words[0]);
    const after = counts();
    expect(after[0]).toBeGreaterThan(0);
    expect(after.slice(2)).toEqual(Array(10).fill(0));
  });
});
