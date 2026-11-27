// @vitest-environment jsdom
/**
 * The user's own lyrics editor (PAR-LYR-10), shared by Parrot web and desktop:
 *   - the words dialog saves pasted words as plain lyrics;
 *   - "Time the lyrics" opens the full-page timing screen, which times each line with a tap at the song's position,
 *     nudges a line ±0.1 s, and saves synced when every line is timed;
 *   - Back returns to the words with every time kept, and the timing screen opens again on them;
 *   - a time that goes back is refused with the line to fix, never sorted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { ParrotLyricsEditorDialog, type ParrotLyricsEditorLabels } from "../src/parrot/own-lyrics";

const T = "[parrot-own-lyrics]";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const labels: ParrotLyricsEditorLabels = {
  title: "Edit lyrics",
  body: "Paste or type the words.",
  placeholder: "Words…",
  timeLyrics: "Time the lyrics",
  saveWords: "Save the words",
  back: "Back",
  timingHint: "Tap as each line starts.",
  timedCount: "{timed} of {total} lines timed",
  tap: "Tap",
  earlier: "Earlier",
  later: "Later",
  replay: "Replay line",
  clearTimes: "Clear times",
  play: "Play",
  pause: "Pause",
  save: "Save",
  cancel: "Cancel",
  saveFailed: "Couldn't save.",
  problems: {
    tooBig: "Too big.",
    empty: "No words.",
    badTime: "Line {line}: bad time.",
    untimedLine: "Line {line} has no time.",
    outOfOrder: "Line {line} starts before the line above it.",
  },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const render = async (node: ReactNode) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
};
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
const q = <E extends HTMLElement = HTMLElement>(id: string) => document.body.querySelector<E>(`[data-testid="${id}"]`);
const all = (id: string) => Array.from(document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
const click = (id: string) => act(async () => q(id)!.click());
const typeText = async (el: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const editor = (extra: { onSave?: (l: unknown) => Promise<void>; position?: () => number; onSeek?: (ms: number) => void; lyrics?: never }) => {
  const onSave = vi.fn(extra.onSave ?? (async () => {}));
  const onOpenChange = vi.fn();
  return {
    onSave,
    onOpenChange,
    node: (
      <ParrotLyricsEditorDialog
        open
        onOpenChange={onOpenChange}
        lyrics={null}
        positionMs={extra.position ?? (() => 0)}
        playing
        onPlayPause={() => {}}
        onSeek={extra.onSeek ?? (() => {})}
        onSave={onSave}
        labels={labels}
      />
    ),
  };
};

// @req PAR-LYR-10[parrot]
describe("[parrot] lyrics editor", () => {
  it("saves pasted words as plain lyrics", async () => {
    const e = editor({});
    await render(e.node);
    console.info(T, "phase: paste");
    await typeText(q<HTMLTextAreaElement>("lyrics-editor-text")!, "First line\nSecond line");
    await click("lyrics-editor-save-words");
    console.info(T, "saved", JSON.stringify(e.onSave.mock.calls[0]?.[0]));
    expect(e.onSave).toHaveBeenCalledWith({ synced: null, plain: "First line\nSecond line" });
    expect(e.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("times each line with a tap at the song's position, nudges one, and saves synced", async () => {
    let now = 1000;
    const onSeek = vi.fn();
    const e = editor({ position: () => now, onSeek });
    await render(e.node);
    await typeText(q<HTMLTextAreaElement>("lyrics-editor-text")!, "First line\nSecond line");
    console.info(T, "phase: timing screen");
    await click("lyrics-editor-time");
    expect(q("lyrics-editor-timing")).not.toBeNull();
    expect(q("lyrics-editor")).toBeNull();
    expect(q("lyrics-editor-count")!.textContent).toBe("0 of 2 lines timed");
    await click("lyrics-editor-tap");
    now = 4000;
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(all("lyrics-editor-line").map((line) => line.dataset.timed)).toEqual(["true", "true"]);
    expect(q("lyrics-editor-count")!.textContent).toBe("2 of 2 lines timed");
    console.info(T, "phase: nudge and replay the second line");
    await click("lyrics-editor-later");
    await click("lyrics-editor-replay");
    expect(onSeek).toHaveBeenCalledWith(4100);
    console.info(T, "phase: back to the words keeps the times");
    await click("lyrics-editor-back");
    expect(q("lyrics-editor-timing")).toBeNull();
    expect(q<HTMLTextAreaElement>("lyrics-editor-text")!.value).toBe("First line\nSecond line");
    await click("lyrics-editor-time");
    expect(q("lyrics-editor-count")!.textContent).toBe("2 of 2 lines timed");
    await click("lyrics-editor-save");
    console.info(T, "saved", JSON.stringify(e.onSave.mock.calls[0]?.[0]));
    expect(e.onSave).toHaveBeenCalledWith({
      synced: [
        { ms: 1000, text: "First line" },
        { ms: 4100, text: "Second line" },
      ],
      plain: "First line\nSecond line",
    });
  });

  it("refuses a time that goes back, with the line to fix, and never sorts it", async () => {
    let now = 5000;
    const e = editor({ position: () => now });
    await render(e.node);
    await typeText(q<HTMLTextAreaElement>("lyrics-editor-text")!, "First line\nSecond line");
    await click("lyrics-editor-time");
    await click("lyrics-editor-tap");
    now = 2000;
    await click("lyrics-editor-tap");
    await click("lyrics-editor-save");
    console.info(T, "problem", q("lyrics-editor-problem")?.textContent);
    expect(q("lyrics-editor-problem")!.textContent).toBe("Line 2 starts before the line above it.");
    expect(e.onSave).not.toHaveBeenCalled();
  });

  it("keeps the editor open with a message when the save fails", async () => {
    const e = editor({ onSave: async () => Promise.reject(new Error("disk")) });
    await render(e.node);
    await typeText(q<HTMLTextAreaElement>("lyrics-editor-text")!, "Words");
    await click("lyrics-editor-save-words");
    expect(q("lyrics-editor-problem")!.textContent).toBe("Couldn't save.");
    expect(e.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
