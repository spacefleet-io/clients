/**
 * The library key as 12 words on the phone and TV apps (Badger, Parrot), in 12 numbered boxes (UX-KEY-01): read-only
 * with a Copy button when a new key is shown on a phone, editable and empty when a key is typed. The boxes type like one long
 * field with no completion offered: Space, the keyboard's action key or a whole word that starts no other moves to the
 * next box, Backspace in an empty box goes back to the one before. Leaving a box turns 4 letters that start a single
 * word of the key's list (decided from every box: a key is made in one list) into that word. A whole phrase (or the
 * old base64 key) pasted or typed into any box fills them all, and each
 * box shows whether its word is a key word. One sentence under the boxes says when 12 real words are not a key. The words and the key they stand for come from
 * `@space/shared/libraryKeyWords`.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, Platform, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import {
  LIBRARY_KEY_WORD_COUNT,
  completeLibraryKeyWords,
  isCompleteLibraryKeyWord,
  libraryKeyWordListOf,
  libraryKeyWordsText,
  readLibraryKeyInput,
  splitPastedLibraryKey,
  type PastedLibraryKey,
  type LibraryKeyInput,
  type LibraryKeyWordList,
} from "@space/shared/libraryKeyWords";
import { MobileButtonFace } from "./components/mobile-button-face";
import { TV_FOCUS_RING_WIDTH } from "./components/tv-focus";
import { useTranslation } from "./i18n";
import { scopeLogger } from "./logger";
import { useMobileShellTheme } from "./theme";

const log = scopeLogger("library-key-words");

/** What a box shows: nothing yet, a word still being typed (the start of several words), a key word, or not one. */
export type LibraryKeyBoxState = "empty" | "typing" | "ok" | "unknown";

/**
 * Columns of boxes: 4 on TV, 2 on every phone. The TV's setup card (620dp wide, UX-TV-33) shows the 12 in 3 rows with
 * the step's title, sentence and buttons, nothing scrolled (UX-KEY-01, UX-TV-17). Three never fit a phone: the longest key word
 * (8 letters) and its number need about 150dp at a 1.3 font scale, and the narrowest supported phone (360dp) has room
 * for two.
 */
export const libraryKeyColumns = (tv: boolean): number => (tv ? 4 : 2);

const EMPTY_BOXES: readonly string[] = Array.from({ length: LIBRARY_KEY_WORD_COUNT }, () => "");

/** Reads one box in `list`, the list every box decides for the key (null while none does). */
const readBoxState = (text: string, typing: boolean, list: LibraryKeyWordList | null): LibraryKeyBoxState => {
  const word = text.trim();
  if (!word) return "empty";
  const read = readLibraryKeyInput(typing ? word : `${word} `, list);
  if (read.status === "ok") return "ok"; // the old base64 key, pasted whole into one box
  if (read.status === "incomplete" && read.words.length === 1) {
    return read.words[0].state === "ok" ? "ok" : read.words[0].state === "partial" ? "typing" : "unknown";
  }
  return "unknown";
};

/**
 * Each box's state, read once per text and list: a keystroke changes one box, so the other 11 are not read against
 * the word lists again. Bounded: cleared when full.
 */
const boxStates = new Map<string, LibraryKeyBoxState>();
const BOX_STATES_MAX = 512;
const boxState = (text: string, typing: boolean, list: LibraryKeyWordList | null): LibraryKeyBoxState => {
  const key = `${typing ? 1 : 0}${list ?? ""}\n${text}`;
  const known = boxStates.get(key);
  if (known) return known;
  if (boxStates.size >= BOX_STATES_MAX) boxStates.clear();
  const state = readBoxState(text, typing, list);
  boxStates.set(key, state);
  return state;
};

/** The text the boxes stand for (their words in order, or the old base64 key) and how it reads. */
export const libraryKeyBoxesText = (boxes: readonly string[]): { text: string; read: LibraryKeyInput } => {
  const text = boxes
    .map((box) => box.trim())
    .filter(Boolean)
    .join(" ");
  return { text, read: readLibraryKeyInput(text) };
};

/**
 * What the boxes show: each box's state (`typingIndex` is the box being typed in, whose start of several words is not
 * yet an error), read in the one list the boxes decide, and whether to say the 12 words are not a key.
 */
export const libraryKeyBoxesView = (
  boxes: readonly string[],
  typingIndex: number | null
): { states: LibraryKeyBoxState[]; checksum: boolean; read: LibraryKeyInput } => {
  const { text, read } = libraryKeyBoxesText(boxes);
  const list = libraryKeyWordListOf(text);
  const states = boxes.map((box, i) => boxState(box, i === typingIndex, list));
  const allFilled = boxes.every((box) => box.trim());
  // 12 words that are each a key word on their own but not in the same list: the whole read names the odd one.
  if (allFilled && read.status === "unknownWord") states[read.position - 1] = "unknown";
  return { states, checksum: allFilled && read.status === "checksum", read };
};

/**
 * Reads text pasted or autofilled into box `index` with `splitPastedLibraryKey` (any separators or none, any case, the
 * old base64 key). Android pastes at the caret, after what the box held: that part is then read on its own.
 */
const readPaste = (shown: readonly string[], index: number, text: string): PastedLibraryKey => {
  const read = splitPastedLibraryKey(text);
  const held = shown[index] ?? "";
  if (read.status === "ok" || !held || !text.startsWith(held)) return read;
  const added = splitPastedLibraryKey(text.slice(held.length));
  return added.status === "ok" ? added : read;
};

/**
 * A paste of more than one word, or of the old base64 key, into box `index`: a whole key fills all 12 boxes, a
 * text that is not one fills them with its pieces from the first box when there are 12 or more, from `index`
 * otherwise, each piece completed in the key's list. Null when `text` is one word being typed.
 */
export const pasteIntoLibraryKeyBoxes = (shown: readonly string[], index: number, text: string): string[] | null => {
  const read = readPaste(shown, index, text);
  if (read.status === "ok") return read.words === null ? [read.keyBase64, ...EMPTY_BOXES.slice(1)] : [...read.words];
  const words = read.pieces;
  if (words.length < 2) return null;
  const start = words.length >= LIBRARY_KEY_WORD_COUNT ? 0 : index;
  // A whole key replaces every box; so do words pasted over an old base64 key in box 1.
  const next =
    words.length >= LIBRARY_KEY_WORD_COUNT || readLibraryKeyInput(shown[0] ?? "").status === "ok" ? [...EMPTY_BOXES] : [...shown];
  words.slice(0, LIBRARY_KEY_WORD_COUNT - start).forEach((word, i) => {
    next[start + i] = word;
  });
  return completeLibraryKeyWords(next);
};

/**
 * Letters typed on from box `index` as one long field: Space ends the word (completed from its first 4 letters in the
 * key's list, with the boxes left before it once that list is known) and the next box takes the typing; a whole word
 * that starts no other moves on by itself; Space in an empty box stays out.
 * Several words arriving at once (fast typing outrunning the focus, a hardware keyboard, `adb input text`) land in
 * their own boxes in this one step, so the joined text never shows in one box. Returns the boxes and the box the
 * typing ends in.
 */
export const typeIntoLibraryKeyBoxes = (
  shown: readonly string[],
  index: number,
  typed: string
): { boxes: string[]; index: number } => {
  const boxes = [...shown];
  const last = LIBRARY_KEY_WORD_COUNT - 1;
  let at = index;
  for (const ch of typed) {
    if (/\s/.test(ch)) {
      const word = boxes[at].trim();
      if (!word) continue;
      boxes[at] = word.toLowerCase();
      completeLibraryKeyWords(boxes).forEach((box, i) => {
        boxes[i] = box;
      });
      if (at < last) at += 1;
      continue;
    }
    boxes[at] = `${boxes[at]}${ch.toLowerCase()}`;
    // A whole word that starts no other ("coconut", not "act") is done: the next box takes the typing.
    if (at < last && isCompleteLibraryKeyWord(boxes[at])) at += 1;
  }
  return { boxes, index: at };
};

/**
 * On Android an empty box holds this zero-width character, the caret after it: a hardware keyboard's Delete there
 * removes it, which shows as a change, where React Native reports no key press. Never part of a word.
 */
export const LIBRARY_KEY_EMPTY_BOX_MARK = "\u200B";

/** A whole key (or 12 pieces or more) or words over an old base64 key: these replace the boxes. */
const replacesBoxes = (shown: readonly string[], index: number, text: string): boolean => {
  const read = readPaste(shown, index, text);
  if (read.status === "ok") return true;
  const count = read.pieces.length;
  return count >= LIBRARY_KEY_WORD_COUNT || (count >= 2 && readLibraryKeyInput(shown[0] ?? "").status === "ok");
};

/** The numbered frame shared by the read-only grid and the boxes a key is typed in. */
const useBoxLayout = (tv: boolean) => {
  const columns = libraryKeyColumns(tv);
  return { columns, cellWidth: `${100 / columns}%` as const };
};

/**
 * A new key's 12 words in the numbered boxes, read-only. On a phone a Copy button copies them as one line, with the
 * screen's `action` (its "Generate a new key") under it. On a TV (UX-TV-33) the boxes sit in one darker frame, each
 * with its number inside it and the word in a fixed-width font, and there is no Copy: nothing on a TV reads its
 * clipboard. The screen puts its own "I've written it down" button under it.
 */
export const LibraryKeyWordsGrid = ({ words, action }: { words: readonly string[]; action?: React.ReactNode }) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const tv = Platform.isTV === true;
  const [copied, setCopied] = useState(false);
  const { cellWidth } = useBoxLayout(tv);
  if (tv) {
    return (
      <View style={[styles.keyboxTv, { borderColor: theme.colors.border, backgroundColor: `${theme.colors.bg}66` }]} testID="library-key-words-keybox">
        <View style={[styles.grid, styles.gridTv]} accessible accessibilityLabel={t("libraryKeyWords.gridLabel")} testID="library-key-words-grid">
          {words.map((word, i) => (
            <View key={i} style={[styles.cellTv, { width: cellWidth }]}>
              <View style={[styles.wordBoxTv, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]} testID={`library-key-words-box-${i + 1}`}>
                <Text style={[styles.numberInTv, { color: theme.colors.textMuted }]}>{i + 1}</Text>
                <Text testID={`library-key-words-grid-${i + 1}`} numberOfLines={1} style={[styles.wordMonoTv, { color: theme.colors.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}>
                  {word}
                </Text>
              </View>
            </View>
          ))}
        </View>
        {action}
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <View style={styles.grid} accessible accessibilityLabel={t("libraryKeyWords.gridLabel")} testID="library-key-words-grid">
        {words.map((word, i) => (
          <View key={i} style={[styles.cell, { width: cellWidth }]}>
            <Text style={[styles.number, { color: theme.colors.textMuted }]}>{i + 1}</Text>
            <View style={[styles.box, { borderColor: theme.colors.controlBorder, backgroundColor: theme.colors.surfaceRaised }]}>
              <Text selectable testID={`library-key-words-grid-${i + 1}`} style={[styles.word, { color: theme.colors.text }]}>
                {word}
              </Text>
            </View>
          </View>
        ))}
      </View>
      <MobileButtonFace
        label={copied ? t("libraryKeyWords.copied") : t("libraryKeyWords.copy")}
        variant="secondary"
        testID="library-key-words-copy"
        onPress={() => {
          Clipboard.setString(libraryKeyWordsText(words));
          setCopied(true);
        }}
      />
      {action}
    </View>
  );
};

/**
 * The 12 numbered boxes a key is typed or pasted in, empty at first. Every change reports the text the boxes stand for
 * and how it reads; the caller goes on only when the read is `ok`, with its `keyBase64`. On TV the boxes are large and
 * ring in the accent colour when the remote is on one. The keyboard's action key on the last box runs
 * `onSubmitEditing`.
 */
export const LibraryKeyWordsInput = ({
  onChangeText,
  label,
  tv = Platform.isTV === true,
  autoFocus,
  onSubmitEditing,
}: {
  onChangeText: (text: string, result: LibraryKeyInput) => void;
  label?: string;
  tv?: boolean;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { cellWidth } = useBoxLayout(tv);
  const [boxes, setBoxes] = useState<string[]>(() => [...EMPTY_BOXES]);
  // The latest boxes for handlers that run after another one in the same tick (a box's blur after a move).
  const latest = useRef<string[]>(boxes);
  const [focused, setFocused] = useState<number | null>(null);
  const inputs = useRef<(TextInputInstance | null)[]>([]);
  // The box the typing goes to: the one focused, or the one asked for focus before the keyboard gets there.
  const target = useRef<number | null>(null);
  // Each box's own text as the keyboard last reported it, which runs ahead of what the box shows while letters
  // typed fast still land in a box the typing has already left.
  const native = useRef<string[]>([...EMPTY_BOXES]);
  const { states, checksum } = useMemo(() => libraryKeyBoxesView(boxes, focused), [boxes, focused]);
  const marked = Platform.OS === "android";
  // Android TV: `autoFocus` puts the remote on box 1 (UX-TV-17) without opening the keyboard, which would cover the
  // screen before the user chose to type; OK on the box opens it, as on every other field. tvOS opens its full-screen
  // keyboard for box 1 as for any focused field: holding it back there (an empty `inputView`) sent the system
  // keyboard into an endless relayout that froze the screen.
  const [quietFocus, setQuietFocus] = useState(tv && autoFocus === true && Platform.OS === "android");
  useEffect(() => {
    if (tv && autoFocus) inputs.current[0]?.focus();
  }, []);

  // An empty box the typing is in keeps its caret after the mark, so Delete there removes the mark.
  const caretAfterMark = (index: number) => {
    if (marked && !latest.current[index]) inputs.current[index]?.setSelection?.(1, 1);
  };
  useEffect(() => {
    if (target.current !== null) caretAfterMark(target.current);
  }, [boxes]);

  const focusBox = (index: number) => {
    if (index < 0 || index >= LIBRARY_KEY_WORD_COUNT) return;
    target.current = index;
    inputs.current[index]?.focus();
  };

  const apply = (next: string[]) => {
    latest.current = next;
    setBoxes(next);
    const { text, read } = libraryKeyBoxesText(next);
    onChangeText(text, read);
  };

  const setBox = (index: number, word: string) => {
    const next = [...latest.current];
    next[index] = word;
    apply(next);
  };

  /**
   * Leaving a box: 4 letters that start a single word of the key's list become that word, and boxes left before the
   * key's list was known become their word in it.
   */
  const resolveBox = (index: number) => {
    const next = completeLibraryKeyWords(latest.current);
    if (next.some((word, i) => word !== latest.current[i])) {
      log.info("resolve", { box: index + 1 });
      apply(next);
    }
  };

  /** Letters typed on from box `at`, several words at once landing in their own boxes in one update. */
  const typeOn = (from: readonly string[], at: number, typed: string) => {
    const next = typeIntoLibraryKeyBoxes(from, at, typed);
    if (next.boxes.some((word, i) => word !== latest.current[i])) apply(next.boxes);
    if (next.index !== at) {
      log.info("advance", { from: at + 1, to: next.index + 1 });
      focusBox(next.index);
    }
  };

  const changeBox = (index: number, reported: string) => {
    const text = reported.replace(/\u200B/g, "");
    const shown = latest.current;
    const before = native.current[index];
    native.current[index] = text;
    // The mark deleted from an empty box: Backspace or a hardware keyboard's Delete, back to the word before.
    if (!text && !shown[index]) {
      log.info("delete in empty box", { box: index + 1 });
      focusBox(index - 1);
      return;
    }
    const pasted =
      replacesBoxes(shown, index, text) || /[^\p{L}\s]/u.test(text) ? pasteIntoLibraryKeyBoxes(shown, index, text) : null;
    if (pasted) {
      const filled = pasted.filter((box) => box.trim()).length;
      log.info("paste", { box: index + 1, filled });
      apply(pasted);
      const firstEmpty = pasted.findIndex((box) => !box.trim());
      focusBox(firstEmpty >= 0 ? firstEmpty : LIBRARY_KEY_WORD_COUNT - 1);
      return;
    }
    // Letters still landing in a box whose word is done while the focus moves on belong to the box the typing went to.
    const runOn = target.current !== null && target.current !== index && shown[index] !== "";
    const into = runOn && target.current !== null ? target.current : index;
    if (!runOn) target.current = index;
    // What was there before the new letters; in a box the typing has left, also what the keyboard last put in it.
    const base = [runOn ? before : null, shown[index]]
      .filter((start): start is string => start !== null && text.startsWith(start))
      .reduce<string | null>((longest, start) => (longest === null || start.length > longest.length ? start : longest), null);
    if (base !== null) {
      if (runOn) log.info("typed on from a box left behind", { box: index + 1, into: into + 1 });
      typeOn(shown, into, text.slice(base.length));
      return;
    }
    // A letter deleted or changed inside the word: the box holds its text as it is now.
    target.current = index;
    const cleared = [...shown];
    cleared[index] = "";
    if (/\s/.test(text)) {
      typeOn(cleared, index, text);
      return;
    }
    setBox(index, text.toLowerCase());
    if (isCompleteLibraryKeyWord(text) && index < LIBRARY_KEY_WORD_COUNT - 1) {
      log.info("advance", { from: index + 1, to: index + 2 });
      focusBox(index + 1);
    }
  };

  // The boxes' handlers, current every render; `actions` hands each box stable functions that call them, so a box
  // re-renders only when what it shows changes, never for a keystroke in another box.
  const handlers = useRef<BoxActions | null>(null);
  handlers.current = {
    register: (index, input) => {
      inputs.current[index] = input;
    },
    change: changeBox,
    selection: (index, start) => {
      if (start === 0) caretAfterMark(index);
    },
    submit: (index) => {
      resolveBox(index);
      if (index === LIBRARY_KEY_WORD_COUNT - 1) onSubmitEditing?.();
      else focusBox(index + 1);
    },
    keyPress: (index, key) => {
      // Backspace in an empty box goes back to the word before (the soft keyboard sends it too).
      if (key === "Backspace" && !latest.current[index]) focusBox(index - 1);
    },
    focus: (index) => {
      if (index === 0 && quietFocus) setQuietFocus(false);
      setFocused(index);
      target.current = index;
      caretAfterMark(index);
    },
    blur: (index) => {
      setFocused((current) => (current === index ? null : current));
      resolveBox(index);
    },
  };
  const actions = useMemo<BoxActions>(
    () => ({
      register: (index, input) => handlers.current?.register(index, input),
      change: (index, text) => handlers.current?.change(index, text),
      selection: (index, start) => handlers.current?.selection(index, start),
      submit: (index) => handlers.current?.submit(index),
      keyPress: (index, key) => handlers.current?.keyPress(index, key),
      focus: (index) => handlers.current?.focus(index),
      blur: (index) => handlers.current?.blur(index),
    }),
    []
  );

  return (
    <View style={styles.wrap}>
      {label ? <Text style={[styles.label, tv && styles.labelTv, { color: theme.colors.textMuted }]}>{label}</Text> : null}
      <View style={styles.grid} testID="library-key-words-input">
        {boxes.map((word, i) => (
          <LibraryKeyBox
            key={i}
            index={i}
            word={word}
            state={states[i]}
            tv={tv}
            marked={marked}
            cellWidth={cellWidth}
            ringed={tv && focused === i}
            autoFocus={autoFocus === true && !tv && i === 0}
            showSoftInputOnFocus={!(quietFocus && i === 0)}
            submits={onSubmitEditing !== undefined}
            actions={actions}
          />
        ))}
      </View>
      {checksum ? (
        <Text testID="library-key-words-message" style={[styles.message, tv && styles.messageTv, { color: theme.colors.danger }]}>
          {t("libraryKeyWords.checksum")}
        </Text>
      ) : null}
    </View>
  );
};

/** What a box reports back to `LibraryKeyWordsInput`, by its index. */
type BoxActions = {
  register: (index: number, input: TextInputInstance | null) => void;
  change: (index: number, text: string) => void;
  selection: (index: number, start: number) => void;
  submit: (index: number) => void;
  keyPress: (index: number, key: string) => void;
  focus: (index: number) => void;
  blur: (index: number) => void;
};

/** One numbered box of `LibraryKeyWordsInput`. Memoized: typing in one box leaves the other 11 as they are. */
const LibraryKeyBox = memo(function LibraryKeyBox({
  index,
  word,
  state,
  tv,
  marked,
  cellWidth,
  ringed,
  autoFocus,
  showSoftInputOnFocus,
  submits,
  actions,
}: {
  index: number;
  word: string;
  state: LibraryKeyBoxState;
  tv: boolean;
  marked: boolean;
  cellWidth: `${number}%`;
  /** TV: the remote is on this box. */
  ringed: boolean;
  autoFocus: boolean;
  showSoftInputOnFocus: boolean;
  /** The caller handles the last box's action key. */
  submits: boolean;
  actions: BoxActions;
}) {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const last = index === LIBRARY_KEY_WORD_COUNT - 1;
  const ref = useCallback((input: TextInputInstance | null) => actions.register(index, input), [actions, index]);
  return (
    <View style={[styles.cell, { width: cellWidth }]}>
      <Text style={[styles.number, tv && styles.numberTv, { color: theme.colors.textMuted }]}>{index + 1}</Text>
      <TextInput
        ref={ref}
        testID={`library-key-word-${index + 1}`}
        accessibilityLabel={
          state === "unknown"
            ? t("libraryKeyWords.wordUnknown", { position: index + 1 })
            : t("libraryKeyWords.word", { position: index + 1 })
        }
        style={[
          styles.box,
          styles.input,
          tv && styles.boxTv,
          tv && styles.wordTv,
          {
            color: state === "unknown" ? theme.colors.danger : theme.colors.text,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor:
              state === "unknown" ? theme.colors.danger : state === "ok" ? theme.colors.success : theme.colors.controlBorder,
          },
          tv && { borderWidth: TV_FOCUS_RING_WIDTH },
          ringed && { borderColor: theme.colors.accent },
        ]}
        value={word || (marked ? LIBRARY_KEY_EMPTY_BOX_MARK : "")}
        onChangeText={(text) => actions.change(index, text)}
        onSelectionChange={({ nativeEvent }) => actions.selection(index, nativeEvent.selection.start)}
        autoFocus={autoFocus}
        showSoftInputOnFocus={showSoftInputOnFocus}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        keyboardType={marked ? "visible-password" : "default"}
        returnKeyType={last ? (submits ? "done" : undefined) : "next"}
        submitBehavior={last ? (submits ? "blurAndSubmit" : undefined) : "submit"}
        onSubmitEditing={() => actions.submit(index)}
        onKeyPress={({ nativeEvent }) => actions.keyPress(index, nativeEvent.key)}
        onFocus={() => actions.focus(index)}
        onBlur={() => actions.blur(index)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: 10 },
  cell: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 },
  number: { fontSize: 13, minWidth: 18, textAlign: "right" },
  numberTv: { fontSize: 16, minWidth: 20 },
  // The word sits in the middle of its box, never cut: a fixed height, no vertical padding (Android adds its own to
  // a TextInput and pushed the text up), and room for the longest word in 2 columns (4 on TV). `height`, not
  // `minHeight`: an Android EditText grows to a multi-line paste ("1. floor\n2. bid\n…") and never shrinks back, which
  // left box 1 four rows tall after the 12 words were spread over the boxes (PhoneKeyProof2 on a OnePlus 6 test phone, 2026-11-12).
  box: {
    flex: 1,
    minWidth: 0,
    height: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 0,
  },
  // TV: 48dp keeps the 4x3 boxes and the card's buttons inside 540dp (UX-TV-17, UX-TV-33).
  boxTv: { height: 48, borderRadius: 12, paddingHorizontal: 8 },
  input: { fontSize: 16, textAlignVertical: "center", includeFontPadding: false },
  word: { fontSize: 16, fontWeight: "700" },
  wordTv: { fontSize: 18 },
  label: { fontSize: 14 },
  labelTv: { fontSize: 22 },
  message: { fontSize: 14 },
  messageTv: { fontSize: 16 },
  // TV's shown key (UX-TV-33): the mockup's pixels halved.
  keyboxTv: { borderWidth: 0.75, borderRadius: 9, padding: 13, gap: 10 },
  gridTv: { rowGap: 8 },
  cellTv: { paddingHorizontal: 4 },
  wordBoxTv: { flexDirection: "row", alignItems: "center", gap: 8, height: 35, borderWidth: 0.75, borderRadius: 7, paddingHorizontal: 11 },
  numberInTv: { fontSize: 11, minWidth: 12, fontVariant: ["tabular-nums"] },
  wordMonoTv: { flexShrink: 1, fontSize: 14, fontWeight: "600" },
});
