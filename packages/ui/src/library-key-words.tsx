import * as React from "react";
import {
  LIBRARY_KEY_WORD_COUNT,
  completeLibraryKeyWords,
  isCompleteLibraryKeyWord,
  libraryKeyWordListOf,
  readLibraryKeyInput,
  splitPastedLibraryKey,
  type LibraryKeyInput,
  type LibraryKeyWordList,
} from "@space/shared/libraryKeyWords";

import { cn } from "./utils";

/** The numbered 12-box layout shared by the key as shown (new key) and the key as typed (UX-KEY-01). */
const BOXES_LAYOUT = "grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:grid-cols-4";
const BOX = "flex h-10 min-w-0 items-center gap-2 rounded-md border bg-background px-2 font-mono text-sm";
const BOX_NUMBER = "w-5 shrink-0 select-none text-right text-xs text-muted-foreground tabular-nums";

/**
 * UX-KEY-01, ACCT-DEV-04: a new library key as its 12 words in 12 numbered read-only boxes, the same layout as the
 * boxes the key is typed into, for Badger and Parrot desktop and their web players. The app puts its own Copy button
 * next to it (copying `libraryKeyWordsText(words)`).
 */
export function LibraryKeyWordsGrid({ words, className }: { words: readonly string[]; className?: string }) {
  return (
    <ol data-testid="library-key-words" className={cn(BOXES_LAYOUT, className)}>
      {words.map((word, index) => (
        <li key={index} className={cn(BOX, "border-border")} data-testid="library-key-word">
          <span className={BOX_NUMBER}>{index + 1}</span>
          <span className="truncate font-medium">{word}</span>
        </li>
      ))}
    </ol>
  );
}

/** The app's translations for the key boxes. */
export type LibraryKeyWordsInputText = {
  /** Names the 12 boxes, e.g. "Library key". */
  label: string;
  /** The one sentence under the boxes when 12 real words are not a key, e.g. "These words don't form a valid key. …" */
  checksum: string;
  /** Screen-reader label of a box whose word is not a key word, e.g. "not a key word". */
  unknownMark: string;
};

/** What one box holds: nothing, a key word (`word` is the full word), the start of several words, or no key word. */
export type LibraryKeyBoxState =
  | { state: "empty" }
  | { state: "ok"; word: string }
  | { state: "partial" }
  | { state: "unknown" };

/**
 * Reads one box. `typing`: the box still has the caret, so the start of several words is fine (`partial`) rather
 * than `unknown`. A box is read with the shared reader, so it accepts every official list and 4-letter starts; `list`
 * is the list the whole key's boxes decide (`libraryKeyWordListOf`), so every box is read in the key's one list.
 */
export const readLibraryKeyBox = (text: string, typing = false, list: LibraryKeyWordList | null = null): LibraryKeyBoxState => {
  const read = readLibraryKeyInput(typing ? text : `${text} `, list);
  if (read.status === "empty") return { state: "empty" };
  if (read.status === "ok" || read.status === "checksum" || read.status === "tooManyWords") return { state: "unknown" };
  if (read.words.length !== 1) return { state: "unknown" };
  const [word] = read.words;
  if (word.state === "ok" && word.word) return { state: "ok", word: word.word.toLowerCase() };
  return { state: word.state === "partial" ? "partial" : "unknown" };
};

/** The 12 box texts held in the app's `value` (one box per line). A lone old base64 key is held as it is. */
export const libraryKeyBoxes = (value: string): string[] => {
  const lines = value.split("\n");
  return Array.from({ length: LIBRARY_KEY_WORD_COUNT }, (_, index) => lines[index] ?? "");
};

/** A lone old base64 key on one line (pasted whole, so it is held as it is rather than as 12 boxes). */
const isLegacy = (value: string) => {
  if (value.trim().includes("\n")) return false;
  const read = readLibraryKeyInput(value);
  return read.status === "ok" && read.words === null;
};

/** What the 12 boxes (as `value`) read as: the key once all 12 words are there and their checksum holds. */
export const readLibraryKeyBoxes = (value: string): LibraryKeyInput => {
  if (isLegacy(value)) return readLibraryKeyInput(value);
  const texts = libraryKeyBoxes(value).map((typed) => typed.trim());
  const list = libraryKeyWordListOf(texts.join(" "));
  const boxes = texts.map((text) => readLibraryKeyBox(text, false, list));
  if (boxes.every((box) => box.state === "empty")) return { status: "empty" };
  const words = texts.map((typed, index) => {
    const box = boxes[index];
    return { typed, word: box.state === "ok" ? box.word : null, state: box.state === "ok" ? ("ok" as const) : ("unknown" as const) };
  });
  const unknown = boxes.findIndex((box) => box.state === "unknown" || box.state === "partial");
  if (unknown >= 0) return { status: "unknownWord", words, position: unknown + 1, typed: words[unknown].typed };
  if (boxes.some((box) => box.state !== "ok")) {
    return { status: "incomplete", words: words.filter((word) => word.typed), count: boxes.filter((box) => box.state === "ok").length };
  }
  return readLibraryKeyInput(texts.join(" "), list);
};

/**
 * UX-KEY-01: where the library key is typed. 12 numbered boxes, one word each, all empty to start with: this screen
 * never shows a key word the user did not type, and offers no completion (no dropdown, no browser autocomplete or
 * spell check). A word's first 4 letters are enough: the box shows the full word once left. Space, Enter or Tab moves
 * to the next box; Backspace in an empty box goes back. Pasting the whole key (or the old 44-character base64 key)
 * into any box fills all 12. Each box shows its own state (empty, a key word, not a key word); one sentence under the
 * boxes says when 12 real words are not a key. `value` holds the boxes, one per line (`libraryKeyBoxes`); `onChange`
 * hands the app the reading, its Continue is enabled only on `ok` and uses `result.keyBase64`. Enter submits once the
 * key reads `ok`.
 */
export function LibraryKeyWordsInput({
  id = "libraryKey",
  value,
  onChange,
  text,
  autoFocus,
  disabled,
  onSubmit,
}: {
  id?: string;
  value: string;
  onChange: (value: string, result: LibraryKeyInput) => void;
  text: LibraryKeyWordsInputText;
  autoFocus?: boolean;
  disabled?: boolean;
  onSubmit?: (result: Extract<LibraryKeyInput, { status: "ok" }>) => void;
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  // An IME composing in a box: its text is left alone until the composition ends, then read like typed text.
  const composing = React.useRef(false);
  const [focused, setFocused] = React.useState<number | null>(null);
  // Blur, Space and paste can each change the boxes within one event; each change starts from the latest value.
  const latest = React.useRef(value);
  latest.current = value;
  const legacy = isLegacy(value);
  const boxes = legacy ? [value.trim(), ...Array<string>(LIBRARY_KEY_WORD_COUNT - 1).fill("")] : libraryKeyBoxes(value);
  const result = React.useMemo(() => readLibraryKeyBoxes(value), [value]);
  // The one list every box is read in, decided from all of them (a key is made in one list).
  const list = React.useMemo(() => (legacy ? null : libraryKeyWordListOf(boxes.join(" "))), [value]);
  const messageId = `${id}-message`;
  const message = result.status === "checksum" ? text.checksum : null;

  const emit = (next: string) => {
    latest.current = next;
    onChange(next, readLibraryKeyBoxes(next));
  };
  const currentBoxes = () => (isLegacy(latest.current) ? Array<string>(LIBRARY_KEY_WORD_COUNT).fill("") : libraryKeyBoxes(latest.current));
  const setBox = (index: number, boxText: string) => {
    const next = currentBoxes();
    next[index] = boxText;
    emit(next.join("\n"));
  };
  /** Moves the caret to box `index`, at the start or the end of its text. */
  const focusBox = (index: number, caret: "start" | "end" = "end") => {
    const element = refs.current[index];
    if (!element) return;
    element.focus();
    const at = caret === "end" ? element.value.length : 0;
    element.setSelectionRange?.(at, at);
  };

  /**
   * The box as left: its full word once it names one in the key's list, lowercase otherwise. Boxes left before the
   * key's list was known become their full word in it now.
   */
  const commit = (index: number) => {
    if (isLegacy(latest.current)) return;
    const current = libraryKeyBoxes(latest.current);
    const next = completeLibraryKeyWords(current);
    if (next[index] === current[index]) next[index] = current[index].trim().toLowerCase();
    if (next.some((boxText, i) => boxText !== current[i])) emit(next.join("\n"));
  };

  /**
   * Writes the boxes into the fields at once, within the event that typed or pasted them, so the field never shows
   * the run-on text (several words in box 1) for a frame while the app's re-render is still to come.
   */
  const paint = (next: readonly string[]) => {
    next.forEach((boxText, index) => {
      const element = refs.current[index];
      if (element && element.value !== boxText) element.value = boxText;
    });
  };

  /**
   * Pasted, autofilled or typed text with several words in it, read by `splitPastedLibraryKey` (any separators or
   * none, any case, the old base64 key): a whole key fills all 12 boxes, a few words fill from `index`.
   */
  const fill = (index: number, pasted: string): boolean => {
    const read = splitPastedLibraryKey(pasted);
    if (read.status === "ok" && read.words === null) {
      paint([read.keyBase64]);
      emit(read.keyBase64);
      return true;
    }
    const words = read.status === "ok" ? read.words : read.pieces;
    if (!words || words.length < 2) return false;
    const start = words.length >= LIBRARY_KEY_WORD_COUNT ? 0 : index;
    const placed = currentBoxes();
    words.slice(0, LIBRARY_KEY_WORD_COUNT - start).forEach((word, offset) => {
      placed[start + offset] = word;
    });
    const next = completeLibraryKeyWords(placed);
    paint(next);
    emit(next.join("\n"));
    focusBox(Math.min(start + words.length, LIBRARY_KEY_WORD_COUNT - 1));
    return true;
  };

  /** What a box now holds after typing (one key, several, a paste the browser inserted, an IME commit). */
  const typedInto = (index: number, typed: string) => {
    if (fill(index, typed)) return;
    const boxText = typed.trim().toLowerCase();
    setBox(index, boxText);
    if (index >= LIBRARY_KEY_WORD_COUNT - 1 || !typed.trim()) return;
    // The 12 boxes type like one long field: a space after a word, or a whole word that starts no
    // other ("coconut", not "act"), moves on by itself.
    if (/\s$/.test(typed) || isCompleteLibraryKeyWord(typed)) focusBox(index + 1, "start");
  };

  return (
    <fieldset className="grid gap-2" disabled={disabled} aria-describedby={message ? messageId : undefined}>
      <legend id={`${id}-label`} className="mb-2 text-sm font-medium leading-none">
        {text.label}
      </legend>
      <div data-testid="library-key-input" role="group" aria-labelledby={`${id}-label`} className={BOXES_LAYOUT}>
        {boxes.map((boxText, index) => {
          if (legacy && index > 0) return null;
          const typing = focused === index;
          const box: LibraryKeyBoxState = legacy ? { state: "ok", word: boxText } : readLibraryKeyBox(boxText, typing, list);
          return (
            <label
              key={index}
              data-testid="library-key-box"
              data-state={box.state}
              className={cn(
                BOX,
                "relative cursor-text focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background",
                box.state === "unknown" ? "border-destructive text-destructive" : box.state === "ok" ? "border-primary/60" : "border-input",
                legacy ? "col-span-full" : null,
              )}
            >
              <span className={BOX_NUMBER}>{index + 1}</span>
              <span className="min-w-0 flex-1">
                <input
                  ref={(element) => {
                    refs.current[index] = element;
                  }}
                  id={index === 0 ? id : `${id}-${index + 1}`}
                  name={`${id}-${index + 1}`}
                  data-testid="library-key-box-input"
                  value={boxText}
                  autoFocus={autoFocus && index === 0}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  aria-invalid={box.state === "unknown" ? true : undefined}
                  className="w-full bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  onFocus={() => setFocused(index)}
                  onBlur={() => {
                    setFocused((current) => (current === index ? null : current));
                    commit(index);
                  }}
                  onPaste={(event) => {
                    if (fill(index, event.clipboardData.getData("text"))) event.preventDefault();
                  }}
                  onChange={(event) => {
                    const typed = event.target.value;
                    if (composing.current || (event.nativeEvent as InputEvent).isComposing) {
                      setBox(index, typed);
                      return;
                    }
                    typedInto(index, typed);
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    composing.current = false;
                    typedInto(index, event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (composing.current || event.nativeEvent.isComposing) return;
                    const element = event.currentTarget;
                    const atStart = element.selectionStart === 0 && element.selectionEnd === 0;
                    const atEnd = element.selectionStart === element.value.length && element.selectionEnd === element.value.length;
                    if ((event.key === "Backspace" || event.key === "ArrowLeft") && atStart && index > 0) {
                      event.preventDefault();
                      focusBox(index - 1, "end");
                      return;
                    }
                    if (event.key === "ArrowRight" && atEnd && index < LIBRARY_KEY_WORD_COUNT - 1) {
                      event.preventDefault();
                      focusBox(index + 1, "start");
                      return;
                    }
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    commit(index);
                    if (event.key === "Enter" && result.status === "ok" && onSubmit) {
                      onSubmit(result);
                      return;
                    }
                    // A space or Enter in an empty box (after a word that moved on by itself) stays put.
                    if (boxText.trim() && index < LIBRARY_KEY_WORD_COUNT - 1) focusBox(index + 1, "start");
                  }}
                />
              </span>
              {box.state === "unknown" ? <span className="sr-only">{text.unknownMark}</span> : null}
            </label>
          );
        })}
      </div>
      {message ? (
        <p id={messageId} role="alert" data-testid="library-key-message" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </fieldset>
  );
}
