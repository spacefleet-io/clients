// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords, type LibraryKeyInput } from "@space/shared/libraryKeyWords";
import { LibraryKeyWordsGrid, LibraryKeyWordsInput, type LibraryKeyWordsInputText } from "../src/library-key-words";

const SUITE = "[library-key-words]";

const text: LibraryKeyWordsInputText = {
  label: "Library key",
  checksum: "These words don't form a valid key. Check each word against the ones you saved.",
  unknownMark: "not a key word",
};

const key = generateLibraryKeyWords("en", (bytes) => bytes.forEach((_, i) => (bytes[i] = i * 17)));

function Harness({
  onResult,
  onSubmit,
}: {
  onResult: (r: LibraryKeyInput) => void;
  onSubmit?: (k: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <LibraryKeyWordsInput
      value={value}
      text={text}
      onChange={(next, result) => {
        setValue(next);
        onResult(result);
      }}
      onSubmit={(result) => onSubmit?.(result.keyBase64)}
    />
  );
}

const inputs = (view: RenderResult) => view.getAllByTestId("library-key-box-input") as HTMLInputElement[];
const boxes = (view: RenderResult) =>
  view.getAllByTestId("library-key-box").map((box) => `${box.getAttribute("data-state")}:${(box.querySelector("input") as HTMLInputElement).value}`);
const dump = (label: string, view: RenderResult, results: LibraryKeyInput[]) =>
  console.info(
    `${SUITE} ${label} boxes=${JSON.stringify(boxes(view))} focused=${document.activeElement?.getAttribute("name") ?? null} result=${JSON.stringify(results.at(-1) ?? null)} message=${JSON.stringify(view.queryByTestId("library-key-message")?.textContent ?? null)}`,
  );

afterEach(cleanup);

// The tests that type a whole key keystroke by keystroke re-render the 12 boxes ~80 times: about 1 s on a quiet
// machine, but over the 5 s default on a loaded CI runner (run 34609).
const TYPING_TIMEOUT_MS = 30_000;

// @req UX-KEY-01[badger-desktop,parrot]
describe("LibraryKeyWordsGrid", () => {
  it("shows the 12 words in 12 numbered boxes", () => {
    const view = render(<LibraryKeyWordsGrid words={key.words} />);
    const items = view.getAllByTestId("library-key-word");
    console.info(`${SUITE} grid ${JSON.stringify(items.map((item) => item.textContent))}`);
    expect(items).toHaveLength(12);
    expect(items[0].firstElementChild?.textContent).toBe("1");
    expect(items[0].lastElementChild?.textContent).toBe(key.words[0]);
    expect(items[11].textContent).toBe(`12${key.words[11]}`);
  });
});

// @req UX-KEY-01[badger-desktop,parrot]
describe("LibraryKeyWordsInput", () => {
  it("shows 12 numbered empty boxes and no textarea", () => {
    const view = render(<Harness onResult={() => undefined} />);
    dump("empty", view, []);
    expect(inputs(view)).toHaveLength(12);
    expect(view.container.querySelector("textarea")).toBeNull();
    expect(boxes(view).every((box) => box === "empty:")).toBe(true);
    expect(view.getAllByTestId("library-key-box").map((box) => box.textContent)).toEqual(key.words.map((_, i) => String(i + 1)));
    // Entering a key never shows key words the user did not type: no list, no example, no dropdown.
    expect(view.queryByTestId("library-key-words")).toBeNull();
    expect(view.queryByRole("listbox")).toBeNull();
    // Nothing completes for the user: no browser autocomplete, autocorrect or spell check, no combobox.
    for (const input of inputs(view)) {
      expect(input.getAttribute("autocomplete")).toBe("off");
      expect(input.getAttribute("autocorrect")).toBe("off");
      expect(input.getAttribute("spellcheck")).toBe("false");
      expect(input.getAttribute("role")).toBeNull();
    }
  });

  it("completes each word from its first 4 letters, moves on with Space, Enter and Tab, and submits the key", () => {
    const results: LibraryKeyInput[] = [];
    const submitted: string[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} onSubmit={(k) => submitted.push(k)} />);

    key.words.forEach((word, index) => {
      const box = inputs(view)[index];
      box.focus();
      fireEvent.change(box, { target: { value: word.slice(0, 4).toUpperCase() } });
      if (index === 0) {
        dump("first prefix typed", view, results);
        // Lowercase while typing, and nothing offered: the full word appears only once the box is left.
        expect(inputs(view)[0].value).toBe(word.slice(0, 4));
        expect(boxes(view)[0]).toBe(`ok:${word.slice(0, 4)}`);
        expect(view.queryByRole("listbox")).toBeNull();
      }
      if (index < 11) {
        fireEvent.keyDown(inputs(view)[index], { key: index % 2 ? "Enter" : " " });
        fireEvent.blur(inputs(view)[index]);
        expect(inputs(view)[index].value).toBe(word);
      }
    });
    dump("all twelve prefixes", view, results);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
    expect(view.queryByTestId("library-key-message")).toBeNull();

    fireEvent.keyDown(inputs(view)[11], { key: "Enter" });
    dump("after Enter on box 12", view, results);
    expect(inputs(view)[11].value).toBe(key.words[11]);
    expect(submitted).toEqual([key.keyBase64]);
  }, TYPING_TIMEOUT_MS);

  it("types like one long field: the whole phrase typed in one go, spaces included, fills boxes 1 to 12", () => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    inputs(view)[0].focus();
    // Keystroke by keystroke, the way a person types it: a space is a key press the box keeps out of its text.
    for (const ch of key.words.join(" ")) {
      const target = document.activeElement as HTMLInputElement;
      if (ch === " ") {
        fireEvent.keyDown(target, { key: " " });
        continue;
      }
      fireEvent.change(target, { target: { value: target.value + ch } });
    }
    dump("typed in one go", view, results);
    expect(inputs(view).map((input) => input.value)).toEqual(key.words);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
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
        const results: LibraryKeyInput[] = [];
        const view = render(<Harness onResult={(r) => results.push(r)} />);
        inputs(view)[0].focus();
        for (const ch of `${typed.join(" ")} `) {
          const target = document.activeElement as HTMLInputElement;
          if (ch === " ") {
            fireEvent.keyDown(target, { key: " " });
            continue;
          }
          fireEvent.change(target, { target: { value: target.value + ch } });
        }
        fireEvent.blur(document.activeElement as HTMLInputElement);
        dump(`${language} key typed as ${how}`, view, results);
        expect(inputs(view).map((input) => input.value)).toEqual(words);
        expect(results.at(-1)).toMatchObject({ status: "ok", words });
      }, TYPING_TIMEOUT_MS);
    }
  }

  it("moves on by itself after a whole word that starts no other, and waits after one that does", () => {
    const view = render(<Harness onResult={() => undefined} />);
    inputs(view)[0].focus();
    fireEvent.change(inputs(view)[0], { target: { value: "coconut" } });
    dump("coconut", view, []);
    expect(document.activeElement).toBe(inputs(view)[1]);
    // "act" is a key word but also starts "action": the box keeps the caret until Space.
    fireEvent.change(inputs(view)[1], { target: { value: "act" } });
    dump("act", view, []);
    expect(document.activeElement).toBe(inputs(view)[1]);
    fireEvent.keyDown(inputs(view)[1], { key: " " });
    expect(document.activeElement).toBe(inputs(view)[2]);
    // A space in an empty box stays put.
    fireEvent.keyDown(inputs(view)[2], { key: " " });
    expect(document.activeElement).toBe(inputs(view)[2]);
    expect(boxes(view).slice(0, 3)).toEqual(["ok:coconut", "ok:act", "empty:"]);
  });

  it("backspaces across boxes: from the start of a box into the end of the one before", () => {
    const view = render(<Harness onResult={() => undefined} />);
    fireEvent.paste(inputs(view)[0], { clipboardData: { getData: () => key.words.slice(0, 3).join(" ") } });
    const third = inputs(view)[2];
    third.focus();
    third.setSelectionRange(0, 0);
    fireEvent.keyDown(third, { key: "Backspace" });
    dump("backspace at start of box 3", view, []);
    const second = inputs(view)[1];
    expect(document.activeElement).toBe(second);
    expect(second.selectionStart).toBe(key.words[1].length);
    // The word before is kept: the next Backspace deletes its last letter (the browser's own).
    expect(second.value).toBe(key.words[1]);
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(document.activeElement).toBe(inputs(view)[2]);
  });

  it("marks an unknown word in its own box", () => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    fireEvent.change(inputs(view)[0], { target: { value: key.words[0] } });
    fireEvent.focus(inputs(view)[1]);
    fireEvent.change(inputs(view)[1], { target: { value: "zzzzq" } });
    fireEvent.blur(inputs(view)[1]);
    dump("unknown", view, results);
    expect(results.at(-1)).toMatchObject({ status: "unknownWord", position: 2, typed: "zzzzq" });
    const box = view.getAllByTestId("library-key-box")[1];
    expect(box.getAttribute("data-state")).toBe("unknown");
    expect(box.textContent).toContain("not a key word");
    expect(inputs(view)[1].getAttribute("aria-invalid")).toBe("true");
    expect(boxes(view)[0]).toBe(`ok:${key.words[0]}`);
    expect(boxes(view)[2]).toBe("empty:");
    // Only a wrong checksum gets the sentence under the boxes.
    expect(view.queryByTestId("library-key-message")).toBeNull();
  });

  it("fills all 12 boxes from a pasted key, whichever box it is pasted into", () => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    const numbered = key.words.map((word, index) => `${index + 1}. ${word.toUpperCase()}`).join("\n");
    fireEvent.paste(inputs(view)[5], { clipboardData: { getData: () => numbered } });
    dump("pasted", view, results);
    expect(inputs(view).map((input) => input.value)).toEqual(key.words);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
  });

  // A copy from a text file or a password manager, whatever is between the words (UX-KEY-01).
  const formats: [string, string][] = [
    ["spaces", key.words.join(" ")],
    ["newlines", key.words.join("\n")],
    ["a numbered list", key.words.map((word, index) => `${index + 1}. ${word}`).join("\n")],
    ["hyphens", key.words.join("-")],
    ["underscores", key.words.join("_")],
    ["commas", key.words.join(", ")],
    ["slashes", key.words.join("/")],
    ["no separators at all", key.words.join("")],
    ["MIXED CASE", key.words.map((word, index) => (index % 2 ? word.toUpperCase() : word)).join(" ")],
    ["junk whitespace around it", `\n\t  ${key.words.join("  ")} \u3000\n`],
  ];
  it.each(formats)("a key pasted into box 1 with %s fills all 12 boxes, the caret in the last one", (label, pasted) => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    inputs(view)[0].focus();
    fireEvent.paste(inputs(view)[0], { clipboardData: { getData: () => pasted } });
    dump(`paste ${label}`, view, results);
    expect(inputs(view).map((input) => input.value)).toEqual(key.words);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
    expect(document.activeElement).toBe(inputs(view)[11]);
  });

  it.each(formats)("a key a password manager writes into box 1 (autofill, no paste event) with %s fills all 12 boxes", (label, filled) => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    fireEvent.change(inputs(view)[0], { target: { value: filled } });
    dump(`autofill ${label}`, view, results);
    expect(inputs(view).map((input) => input.value)).toEqual(key.words);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: key.words });
  });

  it("says once, under the boxes, when 12 real words are not a key, and does not submit them", () => {
    const results: LibraryKeyInput[] = [];
    const onSubmit = vi.fn();
    const view = render(<Harness onResult={(r) => results.push(r)} onSubmit={onSubmit} />);
    const swapped = [key.words[1], key.words[0], ...key.words.slice(2)].join(" ");
    fireEvent.paste(inputs(view)[0], { clipboardData: { getData: () => swapped } });
    dump("swapped", view, results);
    expect(results.at(-1)?.status).toBe("checksum");
    expect(view.getAllByTestId("library-key-message")).toHaveLength(1);
    expect(view.getByTestId("library-key-message").textContent).toBe(text.checksum);
    expect(boxes(view).every((box) => box.startsWith("ok:"))).toBe(true);
    fireEvent.keyDown(inputs(view)[11], { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("goes back a box on Backspace in an empty box", () => {
    const view = render(<Harness onResult={() => undefined} />);
    inputs(view)[3].focus();
    fireEvent.keyDown(inputs(view)[3], { key: "Backspace" });
    console.info(`${SUITE} backspace focused=${document.activeElement?.getAttribute("name")}`);
    expect(document.activeElement).toBe(inputs(view)[2]);
  });

  it("still reads the old base64 key pasted into a box", () => {
    const results: LibraryKeyInput[] = [];
    const view = render(<Harness onResult={(r) => results.push(r)} />);
    fireEvent.paste(inputs(view)[4], { clipboardData: { getData: () => ` ${key.keyBase64} ` } });
    dump("base64", view, results);
    expect(results.at(-1)).toEqual({ status: "ok", keyBase64: key.keyBase64, words: null });
    expect(inputs(view)).toHaveLength(1);
    expect(inputs(view)[0].value).toBe(key.keyBase64);
  });

  describe("several words arriving in one event never show in box 1 together", () => {
    const joined = key.words.join(" ");
    /** Logs box 1 as rendered (from `value`) and as the field holds it when the app hears of the change. */
    function Logged({ log, defer }: { log: { rendered: string[]; atChange: string[] }; defer?: (run: () => void) => void }) {
      const [value, setValue] = useState("");
      log.rendered.push(value.split("\n")[0] ?? "");
      return (
        <LibraryKeyWordsInput
          value={value}
          text={text}
          onChange={(next) => {
            log.atChange.push((document.querySelector('[name="libraryKey-1"]') as HTMLInputElement).value);
            if (defer) defer(() => setValue(next));
            else setValue(next);
          }}
        />
      );
    }
    const expectNoRunOn = (log: { rendered: string[]; atChange: string[] }) => {
      for (const seen of [...log.rendered, ...log.atChange]) expect(seen.trim().split(/\s+/).length).toBeLessThanOrEqual(1);
    };

    it("a 12-word paste fills boxes 1 to 12 with no render of the joined text", () => {
      const log = { rendered: [] as string[], atChange: [] as string[] };
      const view = render(<Logged log={log} />);
      fireEvent.paste(inputs(view)[0], { clipboardData: { getData: () => joined } });
      console.info(`${SUITE} paste rendered=${JSON.stringify(log.rendered)} atChange=${JSON.stringify(log.atChange)}`);
      expectNoRunOn(log);
      expect(inputs(view).map((input) => input.value)).toEqual(key.words);
    });

    it("one change event carrying 12 words fills boxes 1 to 12 with no render of the joined text", () => {
      const log = { rendered: [] as string[], atChange: [] as string[] };
      const view = render(<Logged log={log} />);
      inputs(view)[0].focus();
      fireEvent.change(inputs(view)[0], { target: { value: joined } });
      console.info(`${SUITE} change rendered=${JSON.stringify(log.rendered)} atChange=${JSON.stringify(log.atChange)}`);
      expectNoRunOn(log);
      expect(log.atChange).toEqual([key.words[0]]);
      expect(inputs(view).map((input) => input.value)).toEqual(key.words);
      expect(document.activeElement).toBe(inputs(view)[11]);
    });

    it("box 1 never holds the joined text even while the app's update is still to come", () => {
      const log = { rendered: [] as string[], atChange: [] as string[] };
      const pending: (() => void)[] = [];
      const view = render(<Logged log={log} defer={(run) => pending.push(run)} />);
      inputs(view)[0].focus();
      fireEvent.change(inputs(view)[0], { target: { value: key.words.slice(0, 3).join(" ") } });
      const before = inputs(view).map((input) => input.value);
      console.info(`${SUITE} deferred before-update boxes=${JSON.stringify(before)}`);
      expect(before[0]).not.toContain(" ");
      act(() => pending.forEach((run) => run()));
      expectNoRunOn(log);
      expect(inputs(view).map((input) => input.value).slice(0, 4)).toEqual([...key.words.slice(0, 3), ""]);
    });

    it("waits for the IME to finish before spreading what it committed", () => {
      const log = { rendered: [] as string[], atChange: [] as string[] };
      const view = render(<Logged log={log} />);
      const first = inputs(view)[0];
      first.focus();
      fireEvent.compositionStart(first);
      fireEvent.change(first, { target: { value: "aband" } });
      expect(document.activeElement).toBe(first);
      expect(first.value).toBe("aband");
      fireEvent.change(first, { target: { value: key.words.slice(0, 2).join(" ") } });
      fireEvent.compositionEnd(first);
      dump("after IME commit", view, []);
      expect(inputs(view).map((input) => input.value).slice(0, 3)).toEqual([...key.words.slice(0, 2), ""]);
      expect(document.activeElement).toBe(inputs(view)[2]);
    });
  });
});
