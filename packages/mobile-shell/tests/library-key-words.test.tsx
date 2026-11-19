/**
 * @test-id MOBILE-SHELL-LIBRARY-KEY-WORDS-001
 * @level unit
 * @why Chris (2026-11-12): the library key is shown and typed as 12 words, and "I don't understand this screen" about
 *   the free text field with the recognised words echoed under it. The phone and TV apps (Badger, Parrot) now share
 *   12 numbered boxes (agent reading, approved by Main (2026-11-12)): read-only with Copy for a new key; editable to
 *   type one, a pasted phrase (or the old base64 key) fills the boxes, each box shows its own state, and one sentence
 *   says when 12 real words are not a key. Chris (2026-11-12) then found the screens that show and take the key
 *   confusable: the typed boxes now start empty and fill nothing in while typing. Chris (2026-11-12): "there shouldn't
 *   be any autocomplete on the forms" and "it should feel like a single long input, easy to type and fill in": no
 *   word is offered, a space or a whole word that starts no other moves on, Backspace in an empty box goes back, and
 *   4 letters that start a single word become it when the box is left. Phones show 2 boxes a row with the word
 *   centred and never cut. These tests mount both with the real readings of `@space/shared/libraryKeyWords`.
 * @req UX-KEY-01[badger-mobile,badger-tv,parrot]
 * @req UX-TV-17[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  platform: { isTV: false, OS: "android" },
  clipboard: { setString: vi.fn() },
}));

vi.mock("react-native", () => ({
  Clipboard: stubs.clipboard,
  Platform: stubs.platform,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../src/components/mobile-button-face", () => ({ MobileButtonFace: "MobileButtonFace" }));
vi.mock("../src/logger", () => ({
  scopeLogger: () => ({ info: (...args: unknown[]) => console.info("[MOBILE-SHELL-LIBRARY-KEY-WORDS-001] log", ...args) }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: {
      accent: "#f4a261",
      text: "#fff",
      textMuted: "#999",
      controlBorder: "#333",
      surfaceRaised: "#222",
      danger: "#e00",
      success: "#0c0",
    },
    accentTextHex: "#000",
  }),
}));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: "en" },
  }),
}));

import {
  generateLibraryKeyWords,
  isCompleteLibraryKeyWord,
  readLibraryKeyInput,
  type LibraryKeyInput,
} from "@space/shared/libraryKeyWords";
import en from "../src/i18n/en.json";
import de from "../src/i18n/de.json";
import es from "../src/i18n/es.json";
import fr from "../src/i18n/fr.json";
import nl from "../src/i18n/nl.json";
import { TV_FOCUS_RING_WIDTH } from "../src/components/tv-focus";
import {
  LibraryKeyWordsGrid,
  LibraryKeyWordsInput,
  libraryKeyColumns,
} from "../src/libraryKeyWords";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-KEY-WORDS-001]";
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};

const key = generateLibraryKeyWords("en", (bytes) => bytes.set(Array.from({ length: bytes.length }, (_, i) => i * 17)));

let tree: ReactTestRenderer | null = null;
const focused: number[] = [];
/** Where each box's caret was put, as `box@start-end`. */
const carets: string[] = [];

const mount = (element: React.ReactElement) => {
  act(() => {
    tree = create(element, {
      // Each box's ref: `focus` records which box took the typing.
      createNodeMock: (node) => {
        const props: unknown = node.props;
        const id = props && typeof props === "object" && "testID" in props ? String(props.testID) : "";
        const match = /^library-key-word-(\d+)$/.exec(id);
        return {
          focus: () => match && focused.push(Number(match[1])),
          setSelection: (start: number, end: number) => match && carets.push(`${match[1]}@${start}-${end}`),
        };
      },
    });
  });
  return tree!;
};

const box = (n: number): ReactTestInstance => tree!.root.find((node) => node.props.testID === `library-key-word-${n}`);
const boxes = () => Array.from({ length: 12 }, (_, i) => box(i + 1));
/** What each box shows, without the zero-width mark an empty Android box holds. */
const shown = () => boxes().map((input) => String(input.props.value).replace(/\u200B/g, ""));
const border = (n: number) => flat(box(n).props.style).borderColor;
const message = () => tree!.root.findAll((node) => node.props.testID === "library-key-words-message");
/** Anything a box could offer to complete the word with (there must be none). */
const offered = () => tree!.root.findAll((node) => /suggestion/.test(String(node.props.testID ?? "")));

/** The width every numbered cell takes in its row (all 12 are the same). */
const cellWidths = () =>
  [...new Set(tree!.root.findAll((n) => String(n.type) === "View" && flat(n.props.style).width !== undefined).map((n) => flat(n.props.style).width))];
/** Everything the boxes show, for the log before an assertion. */
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}`,
    JSON.stringify({
      shown: shown(),
      borders: boxes().map((input) => flat(input.props.style).borderColor),
      labels: boxes().map((input) => input.props.accessibilityLabel),
      message: message().map((node) => node.props.children),
      focused,
    })
  );

const typeInto = (n: number, text: string) => act(() => box(n).props.onChangeText(text));
/** Types `word` into box `n` a letter at a time, as a keyboard does (each change is the box's text plus one letter). */
const typeLetters = (n: number, word: string) => {
  for (const letter of word) typeInto(n, `${box(n).props.value}${letter}`);
};

const mountInput = (props: Partial<React.ComponentProps<typeof LibraryKeyWordsInput>> = {}) => {
  const onChangeText = vi.fn<(text: string, result: LibraryKeyInput) => void>();
  mount(<LibraryKeyWordsInput label="Library key" onChangeText={onChangeText} {...props} />);
  const last = () => onChangeText.mock.calls.at(-1);
  return { onChangeText, last };
};

beforeEach(() => {
  focused.length = 0;
  carets.length = 0;
});

// The tests that type a whole key letter by letter re-render the 12 boxes ~80 times: about 1 s on a quiet machine,
// but over the 5 s default on a loaded CI runner (run 34650).
const TYPING_TIMEOUT_MS = 30_000;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  stubs.platform.isTV = false;
  stubs.platform.OS = "android";
  stubs.clipboard.setString.mockClear();
});

describe("LibraryKeyWordsGrid", () => {
  it("shows the 12 words in numbered boxes and copies them as one line, then says Copied", () => {
    mount(<LibraryKeyWordsGrid words={key.words} />);
    const words = Array.from({ length: 12 }, (_, i) => tree!.root.find((n) => n.props.testID === `library-key-words-grid-${i + 1}`));
    const numbers = tree!.root
      .findAll((n) => String(n.type) === "Text" && typeof n.props.children === "number")
      .map((n) => n.props.children);
    console.info(SUITE, "grid", JSON.stringify(words.map((w) => w.props.children)), "numbers", JSON.stringify(numbers));
    expect(words.map((w) => w.props.children)).toEqual(key.words);
    expect(numbers).toEqual(key.words.map((_, i) => i + 1));
    expect(tree!.root.findAll((n) => String(n.type) === "TextInput")).toHaveLength(0);
    expect(tree!.root.find((n) => n.props.testID === "library-key-words-grid").props.accessibilityLabel).toBe(
      "libraryKeyWords.gridLabel"
    );
    const copy = tree!.root.find((n) => String(n.type) === "MobileButtonFace");
    expect(copy.props.label).toBe("libraryKeyWords.copy");
    act(() => copy.props.onPress());
    console.info(SUITE, "copied", stubs.clipboard.setString.mock.calls[0]?.[0]);
    expect(stubs.clipboard.setString).toHaveBeenCalledWith(key.words.join(" "));
    expect(tree!.root.find((n) => String(n.type) === "MobileButtonFace").props.label).toBe("libraryKeyWords.copied");
  });

  it("lays 4 boxes a row on TV (3 rows fit the TV's setup card) and 2 on every phone, the whole word shown", () => {
    expect([libraryKeyColumns(true), libraryKeyColumns(false)]).toEqual([4, 2]);
    mount(<LibraryKeyWordsGrid words={key.words} />);
    const word = tree!.root.find((n) => n.props.testID === "library-key-words-grid-1");
    console.info(SUITE, "phone cell widths", JSON.stringify(cellWidths()), "numberOfLines", word.props.numberOfLines);
    expect(cellWidths()).toEqual(["50%"]);
    // A long word wraps rather than being cut with an ellipsis.
    expect(word.props.numberOfLines).toBeUndefined();
    act(() => tree!.unmount());
    stubs.platform.isTV = true;
    mount(<LibraryKeyWordsGrid words={key.words} />);
    console.info(SUITE, "tv cell widths", JSON.stringify(cellWidths()));
    expect(cellWidths()).toEqual(["25%"]);
  });

  it("puts the action under Copy on a phone", () => {
    const action = React.createElement("ActionStub");
    mount(<LibraryKeyWordsGrid words={key.words} action={action} />);
    const order = tree!.root.findAll((n) => String(n.type) === "MobileButtonFace" || String(n.type) === "ActionStub").map((n) => String(n.type));
    console.info(SUITE, "phone buttons", JSON.stringify(order));
    expect(order).toEqual(["MobileButtonFace", "ActionStub"]);
  });

  // @req UX-TV-33[badger-tv]
  it("TV: the 12 words in one frame, each number inside its box, and no Copy (a TV's clipboard reaches nothing)", () => {
    stubs.platform.isTV = true;
    mount(<LibraryKeyWordsGrid words={key.words} />);
    const keybox = tree!.root.find((n) => n.props.testID === "library-key-words-keybox" && String(n.type) === "View");
    const boxes = Array.from({ length: 12 }, (_, i) => keybox.find((n) => n.props.testID === `library-key-words-box-${i + 1}` && String(n.type) === "View"));
    const inBox = boxes.map((box) => box.findAll((n) => String(n.type) === "Text").map((n) => n.props.children));
    console.info(SUITE, "tv boxes", JSON.stringify(inBox));
    expect(inBox).toEqual(key.words.map((word, i) => [i + 1, word]));
    expect(tree!.root.findAll((n) => String(n.type) === "MobileButtonFace")).toHaveLength(0);
    expect(tree!.root.findAll((n) => n.props.testID === "library-key-words-copy")).toHaveLength(0);
    // Nothing in the frame takes the remote: it goes from Back to the main button.
    expect(keybox.findAll((n) => n.props.focusable === true || String(n.type) === "Pressable" || String(n.type) === "TextInput")).toHaveLength(0);
  });
});

describe("LibraryKeyWordsInput", () => {
  it("shows 12 empty numbered boxes, labelled by their number, and no message", () => {
    mountInput();
    dump("empty");
    expect(shown()).toEqual(Array(12).fill(""));
    expect(boxes().map((input) => input.props.accessibilityLabel)).toEqual(
      boxes().map((_, i) => `libraryKeyWords.word {"position":${i + 1}}`)
    );
    expect(tree!.root.findAll((n) => String(n.type) === "TextInput")).toHaveLength(12);
    expect(message()).toHaveLength(0);
    // Phone: 2 boxes a row, the typed word in the middle of a box tall enough for it.
    expect(cellWidths()).toEqual(["50%"]);
    const style = flat(box(1).props.style);
    console.info(SUITE, "phone box style", JSON.stringify(style));
    // A fixed height: a multi-line paste must not leave box 1 taller than the others (PhoneKeyProof2 on a OnePlus 6 test phone).
    expect(style).toMatchObject({ height: 44, paddingVertical: 0, textAlignVertical: "center", includeFontPadding: false });
    expect(style.minHeight).toBeUndefined();
    // Nothing completes the word: no row of words, no keyboard suggestions or autocorrect.
    expect(offered()).toHaveLength(0);
    expect(box(1).props).toMatchObject({ autoCorrect: false, spellCheck: false, autoComplete: "off", keyboardType: "visible-password" });
  });

  it("fills nothing in while typing and offers no word; deleting a letter fills nothing back in", () => {
    const { last } = mountInput();
    act(() => box(1).props.onFocus());
    typeLetters(1, "ABAN");
    dump("after ABAN");
    expect(box(1).props.value).toBe("aban");
    expect(offered()).toHaveLength(0);
    expect(focused).toEqual([]);
    expect(last()?.[0]).toBe("aban");
    typeInto(1, "aba");
    expect(box(1).props.value).toBe("aba");
    expect(offered()).toHaveLength(0);
  });

  it("types like one long field: the whole phrase typed letter by letter, spaces included, fills boxes 1 to 12", () => {
    const { last } = mountInput();
    let current = 1;
    for (const ch of key.words.join(" ")) {
      const before = focused.length;
      typeInto(current, `${box(current).props.value}${ch}`);
      // Whichever box the typing moved to takes the next letter, as the keyboard would.
      if (focused.length > before) current = focused.at(-1)!;
    }
    dump("typed in one go");
    expect(shown()).toEqual(key.words);
    expect(last()?.[1]).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
  }, TYPING_TIMEOUT_MS);

  // One list per key, decided from every box: French `engin` (also the start of English `engine`) stays `engin`.
  const keys = {
    french: "engin ancien balcon favori futur volcan univers tissu abandon amateur angle badge",
    english: "engine absurd alarm animal balance cabin camera canal carbon civil bronze correct",
  };
  for (const [language, phrase] of Object.entries(keys)) {
    const words = phrase.split(" ");
    for (const [how, typed] of [
      ["whole words", words],
      ["first 4 letters", words.map((word) => word.slice(0, 4))],
    ] as const) {
      it(`@bugfix @regression-proof a ${language} key typed as ${how} stays ${language} in every box`, () => {
        const { last } = mountInput();
        let current = 1;
        for (const ch of `${typed.join(" ")} `) {
          const before = focused.length;
          typeInto(current, `${box(current).props.value}${ch}`);
          if (focused.length > before) current = focused.at(-1)!;
        }
        dump(`${language} key typed as ${how}`);
        expect(shown()).toEqual(words);
        expect(last()?.[1]).toMatchObject({ status: "ok", words });
        // Every box reads as a key word of the key's list (green), none as not a key word.
        expect(boxes().map((_, i) => border(i + 1))).toEqual(Array(12).fill("#0c0"));
      }, TYPING_TIMEOUT_MS);
    }
  }

  it("moves on by itself after a whole word that starts no other, and waits after one that does", () => {
    mountInput();
    typeLetters(1, "coconut");
    dump("after coconut");
    expect(focused).toEqual([2]);
    // "act" is a key word but also starts "action": the box keeps the typing until Space.
    typeLetters(2, "act");
    expect(focused).toEqual([2]);
    typeInto(2, "act ");
    expect(focused).toEqual([2, 3]);
    expect(shown().slice(0, 3)).toEqual(["coconut", "act", ""]);
  });

  it("4 letters that start a single word become it when the box is left; the start of several stays as typed", () => {
    const { last } = mountInput();
    const word = key.words.find((w) => w.length > 4)!;
    act(() => box(1).props.onFocus());
    typeLetters(1, word.slice(0, 4).toUpperCase());
    expect(box(1).props.value).toBe(word.slice(0, 4).toLowerCase());
    act(() => box(1).props.onBlur());
    dump("after leaving box 1");
    expect(box(1).props.value).toBe(word);
    expect(last()?.[0]).toBe(word);
    act(() => box(2).props.onFocus());
    typeLetters(2, "ab");
    act(() => box(2).props.onBlur());
    dump("after leaving box 2");
    expect(box(2).props.value).toBe("ab");
  });

  it("Space or the keyboard's action key moves to the next box; the last box's action key submits", () => {
    const onSubmitEditing = vi.fn();
    mountInput({ onSubmitEditing });
    typeInto(1, `${key.words[0].slice(0, 4)} `);
    dump("after space");
    expect(box(1).props.value).toBe(key.words[0]);
    expect(focused).toEqual([2]);
    // "ab" starts several words: only the action key moves on.
    typeLetters(2, "ab");
    act(() => box(2).props.onSubmitEditing());
    expect(focused).toEqual([2, 3]);
    expect(box(2).props.returnKeyType).toBe("next");
    expect(box(12).props.returnKeyType).toBe("done");
    act(() => box(12).props.onSubmitEditing());
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    // Space in an empty box does nothing.
    typeInto(3, " ");
    expect(shown()[2]).toBe("");
    expect(focused).toEqual([2, 3]);
  });

  it("Backspace in an empty box goes back to the box before", () => {
    mountInput();
    act(() => box(4).props.onKeyPress({ nativeEvent: { key: "Backspace" } }));
    typeInto(5, "a");
    act(() => box(5).props.onKeyPress({ nativeEvent: { key: "Backspace" } }));
    console.info(SUITE, "focused after backspaces", JSON.stringify(focused));
    expect(focused).toEqual([3]);
  });

  it("each box shows its own state: an unknown word at once, the start of several words once another box is typed in", () => {
    mountInput();
    typeInto(1, "zzzz");
    act(() => box(2).props.onFocus());
    typeInto(2, "ab");
    dump("unknown and typing");
    expect(border(1)).toBe("#e00");
    expect(box(1).props.accessibilityLabel).toBe('libraryKeyWords.wordUnknown {"position":1}');
    expect(border(2)).toBe("#333");
    act(() => box(2).props.onBlur());
    act(() => box(3).props.onFocus());
    dump("after focusing box 3");
    expect(border(2)).toBe("#e00");
    expect(message()).toHaveLength(0);
  });

  it("a whole phrase pasted into any box fills all 12, numbered or not, and reads as the key", () => {
    const { last } = mountInput();
    const numbered = key.words.map((word, i) => `${i + 1}. ${word.toUpperCase()}`).join("\n");
    typeInto(5, numbered);
    dump("after paste into box 5");
    expect(shown()).toEqual(key.words);
    expect(boxes().every((_, i) => border(i + 1) === "#0c0")).toBe(true);
    expect(last()).toEqual([key.words.join(" "), { status: "ok", keyBase64: key.keyBase64, words: key.words }]);
    expect(message()).toHaveLength(0);
  });

  it("a few pasted words fill the boxes from the one pasted into, and the typing goes on after them", () => {
    mountInput();
    typeInto(3, `${key.words[2]} ${key.words[3]}`);
    dump("after a 2-word paste into box 3");
    expect(shown().slice(0, 5)).toEqual(["", "", key.words[2], key.words[3], ""]);
    // Box 4 keeps the typing unless its word starts no other, as when typed.
    const ends = isCompleteLibraryKeyWord(key.words[3]) ? 5 : 4;
    expect(focused.at(-1)).toBe(ends);
  });

  // A copy from a text file or a password manager, whatever is between the words (UX-KEY-01). Android hands the whole
  // box text in one onChangeText, the empty box's zero-width mark in front.
  const french = generateLibraryKeyWords("fr", (bytes) => bytes.fill(9));
  const formats: [string, string, typeof key][] = [
    ["spaces", key.words.join(" "), key],
    ["newlines", key.words.join("\n"), key],
    ["a numbered list", key.words.map((word, i) => `${i + 1}. ${word}`).join("\n"), key],
    ["hyphens", key.words.join("-"), key],
    ["underscores", key.words.join("_"), key],
    ["commas", key.words.join(", "), key],
    ["slashes", key.words.join("/"), key],
    ["no separators at all", key.words.join(""), key],
    ["MIXED CASE", key.words.map((word, i) => (i % 2 ? word.toUpperCase() : word)).join(" "), key],
    ["junk whitespace around it", `\n\t  ${key.words.join("  ")} \u3000\n`, key],
    ["French words with accents, no separators", french.words.join(""), french],
    ["French words without accents", french.words.map((word) => word.normalize("NFKD").replace(/\p{M}+/gu, "")).join(" "), french],
  ];
  it.each(formats)("a key pasted or autofilled into box 1 with %s fills all 12 boxes and reads as the key", (label, pasted, made) => {
    const { last } = mountInput();
    typeInto(1, `\u200B${pasted}`);
    dump(`after ${label} into box 1`);
    expect(shown()).toEqual(made.words);
    expect(last()).toEqual([made.words.join(" "), { status: "ok", keyBase64: made.keyBase64, words: made.words }]);
    expect(focused.at(-1)).toBe(12);
    expect(message()).toHaveLength(0);
  });

  it("a key pasted after letters already in box 1 (Android pastes at the caret) still fills all 12", () => {
    const { last } = mountInput();
    typeLetters(1, "ab");
    typeInto(1, `ab${key.words.join("")}`);
    dump("after a run-on paste behind 'ab'");
    expect(shown()).toEqual(key.words);
    expect(last()?.[1]).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
  });

  it("a run-on paste that is not one key is not taken as a key", () => {
    const { last } = mountInput();
    const bad = [...key.words.slice(0, 11), key.words[11] === "zoo" ? "abandon" : "zoo"];
    typeInto(1, bad.join(""));
    dump("after a run-on paste with a bad checksum");
    expect(last()?.[1].status).not.toBe("ok");
  });

  it("@bugfix letters typed faster than the focus moves never show joined in one box: each lands in its own box at once", () => {
    const { last } = mountInput();
    // Three key words, the first one starting no other, so box 1 moves on by itself with no Space typed.
    const first = key.words.findIndex((word, i) => i < 10 && isCompleteLibraryKeyWord(word));
    expect(first).toBeGreaterThanOrEqual(0);
    const words = key.words.slice(first, first + 3);
    // As a person types: Space only after a word that starts others.
    const phrase = words.map((word) => (isCompleteLibraryKeyWord(word) ? word : `${word} `)).join("");
    console.info(SUITE, "run-on phrase", JSON.stringify(phrase));
    // `adb input text` or fast typing on an older phone: every letter still lands in box 1, which reports its whole text each time.
    for (let n = 1; n <= phrase.length; n += 1) {
      typeInto(1, phrase.slice(0, n));
      const now = shown();
      const joined = now.some((word) => /\s/.test(word)) || now[0].length > words[0].length;
      if (joined) dump(`joined after ${n} letters`);
      expect(joined).toBe(false);
    }
    dump("after the run-on");
    expect(shown().slice(0, 3)).toEqual(words);
    expect(last()?.[0]).toBe(words.join(" "));
    // Box 1's own text caught up with what it shows; a letter still landing there goes on in the box typed in.
    const typingIn = focused.at(-1)!;
    typeInto(1, `${words[0]}x`);
    dump("after a letter in box 1 once it shows its word");
    expect(shown()[0]).toBe(words[0]);
    expect(shown()[typingIn - 1].endsWith("x")).toBe(true);
  });

  it("@bugfix several words in one change (a keyboard batching letters) split in that same update", () => {
    const { onChangeText } = mountInput();
    act(() => box(1).props.onFocus());
    typeInto(1, `${key.words[0]} ${key.words[1]} ${key.words[2].slice(0, 2)}`);
    dump("after one batched change");
    expect(onChangeText).toHaveBeenCalledTimes(1);
    expect(shown().slice(0, 4)).toEqual([key.words[0], key.words[1], key.words[2].slice(0, 2), ""]);
    expect(focused.at(-1)).toBe(3);
  });

  it("@bugfix Delete on a hardware keyboard in an empty box goes back: the box's zero-width mark goes, no key press comes", () => {
    mountInput();
    expect(box(5).props.value).toBe("\u200B");
    act(() => box(5).props.onFocus());
    console.info(SUITE, "carets after focusing box 5", JSON.stringify(carets));
    expect(carets).toContain("5@1-1");
    typeLetters(5, "ab");
    expect(box(5).props.value).toBe("ab");
    // Deleting the last letter empties the box and stays there; deleting again removes the mark and goes back.
    typeInto(5, "a");
    typeInto(5, "");
    expect(box(5).props.value).toBe("\u200B");
    expect(focused).toEqual([]);
    typeInto(5, "");
    dump("after Delete in the empty box 5");
    expect(focused).toEqual([4]);
    // A caret put before the mark goes back after it.
    carets.length = 0;
    act(() => box(4).props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
    expect(carets).toEqual(["4@1-1"]);
  });

  it("has no mark on iOS: an empty box is empty", () => {
    stubs.platform.OS = "ios";
    mountInput();
    expect(box(1).props.value).toBe("");
    expect(box(1).props.keyboardType).toBe("default");
  });

  it("still takes the old 44-character base64 key, pasted with spaces into any box", () => {
    const { last } = mountInput();
    const spaced = `${key.keyBase64.slice(0, 10)} ${key.keyBase64.slice(10)}`;
    typeInto(7, spaced);
    dump("after base64 paste");
    expect(box(1).props.value).toBe(key.keyBase64);
    expect(border(1)).toBe("#0c0");
    expect(last()).toEqual([key.keyBase64, { status: "ok", keyBase64: key.keyBase64, words: null }]);
  });

  it("says in one sentence when 12 real words are not a key, and only then", () => {
    const { last } = mountInput();
    let swapped: string[] | null = null;
    for (let i = 0; i < 12 && !swapped; i += 1) {
      for (let j = i + 1; j < 12 && !swapped; j += 1) {
        const words = [...key.words];
        [words[i], words[j]] = [words[j], words[i]];
        if (words[i] !== words[j] && readLibraryKeyInput(words.join(" ")).status === "checksum") swapped = words;
      }
    }
    expect(swapped).not.toBeNull();
    typeInto(1, swapped!.join(" "));
    dump("after swapped paste");
    expect(last()?.[1].status).toBe("checksum");
    expect(message().map((node) => node.props.children)).toEqual(["libraryKeyWords.checksum"]);
    expect(boxes().every((_, i) => border(i + 1) === "#0c0")).toBe(true);
    typeInto(12, "");
    dump("after emptying box 12");
    expect(message()).toHaveLength(0);
  });

  it("on TV: the words and the accent ring on the box the remote is on, 3 rows of 4 fixed-height boxes", () => {
    stubs.platform.isTV = true;
    mountInput();
    act(() => box(3).props.onFocus());
    const style = flat(box(3).props.style);
    console.info(SUITE, "tv focused box", JSON.stringify(style));
    expect(style.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(style.borderColor).toBe("#f4a261");
    expect(style.fontSize).toBe(15);
    expect(flat(box(4).props.style).borderColor).toBe("#333");
    expect(cellWidths()).toEqual(["25%"]);
    // 28 dp (56 px on a 1080p TV), so the key step fits under the mascot (UX-SETUP-08).
    expect(style.height).toBe(28);
    expect(style.minHeight).toBeUndefined();
    expect(offered()).toHaveLength(0);
  });

  it("on Android TV with autoFocus: the remote starts on box 1 without opening the keyboard; the next focus may open it", () => {
    stubs.platform.isTV = true;
    mountInput({ autoFocus: true });
    console.info(SUITE, "tv autoFocus", JSON.stringify({ focused, autoFocus: box(1).props.autoFocus, soft: box(1).props.showSoftInputOnFocus }));
    expect(focused).toEqual([1]);
    expect(box(1).props.autoFocus).toBe(false);
    expect(box(1).props.showSoftInputOnFocus).toBe(false);
    expect(box(2).props.showSoftInputOnFocus).toBe(true);
    act(() => box(1).props.onFocus());
    console.info(SUITE, "after first focus", box(1).props.showSoftInputOnFocus);
    expect(box(1).props.showSoftInputOnFocus).toBe(true);
  });

  it("@bugfix @regression-proof on Apple TV with autoFocus: the remote starts on box 1 and no box holds the keyboard back (no empty inputView)", () => {
    stubs.platform.isTV = true;
    stubs.platform.OS = "ios";
    mountInput({ autoFocus: true });
    console.info(SUITE, "tvOS autoFocus", JSON.stringify({ focused, soft: boxes().map((b) => b.props.showSoftInputOnFocus) }));
    expect(focused).toEqual([1]);
    expect(box(1).props.autoFocus).toBe(false);
    expect(boxes().every((b) => b.props.showSoftInputOnFocus === true)).toBe(true);
  });

  it("on a phone with autoFocus: box 1 autofocuses with its keyboard, as before", () => {
    mountInput({ autoFocus: true });
    console.info(SUITE, "phone autoFocus", JSON.stringify({ focused, autoFocus: box(1).props.autoFocus, soft: box(1).props.showSoftInputOnFocus }));
    expect(box(1).props.autoFocus).toBe(true);
    expect(box(1).props.showSoftInputOnFocus).toBe(true);
    expect(focused).toEqual([]);
  });
});

describe("libraryKeyWords strings", () => {
  it("exist in every app language, with the checksum sentence of the contract in English", () => {
    const keys = ["copy", "copied", "checksum", "word", "wordUnknown", "gridLabel"];
    for (const [language, texts] of Object.entries({ en, fr, es, de, nl })) {
      const own = (texts as { libraryKeyWords?: Record<string, string> }).libraryKeyWords ?? {};
      console.info(SUITE, language, JSON.stringify(own));
      expect(Object.keys(own).sort(), language).toEqual([...keys].sort());
      expect(own.word, language).toContain("{{position}}");
      expect(own.wordUnknown, language).toContain("{{position}}");
      const { onboarding } = texts;
      console.info(SUITE, language, "titles", onboarding.enterTitle, "/", onboarding.showTitle);
      expect(onboarding.enterTitle, language).toBeTruthy();
      expect(onboarding.showTitle, language).toBeTruthy();
      expect(onboarding.enterTitle, language).not.toBe(onboarding.showTitle);
    }
    expect(en.libraryKeyWords.checksum).toBe("These words don't form a valid key. Check each word against the ones you saved.");
    expect([en.onboarding.enterTitle, en.onboarding.showTitle]).toEqual(["Enter your media library key", "Your media library key"]);
  });
});
