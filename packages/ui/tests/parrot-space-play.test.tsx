// @vitest-environment jsdom
/**
 * @bugfix @regression-proof Parrot desktop 0.1.57 (Chris, 2026-11-25): after a click on Next, space pressed Next again
 * and skipped another song instead of pausing. jsdom runs no default actions, so `press` plays the browser's part:
 * a space keydown nobody prevented clicks a focused button and types a space into a focused field.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParrotPlayerBar } from "../src/parrot/screens";

const log = (msg: string, payload?: unknown) => console.info(`[parrot-space-play.test] ${msg}`, payload ?? "");

const labels = {
  play: "Play",
  pause: "Pause",
  previous: "Previous",
  next: "Next",
  shuffle: "Shuffle",
  repeatOff: "Repeat off",
  repeatAll: "Repeat all",
  repeatOne: "Repeat one",
  seek: "Seek",
  lyrics: "Lyrics",
  queue: "Queue",
  openNowPlaying: "Open now playing",
  error: "Error",
};

function renderBar(extra?: React.ReactNode) {
  const onToggle = vi.fn();
  const onNext = vi.fn();
  const onSeek = vi.fn();
  render(
    <>
      <input aria-label="Search" data-testid="search-field" />
      <div contentEditable suppressContentEditableWarning data-testid="lyrics-editor" />
      {extra}
      <ParrotPlayerBar
        track={{ id: "trk-1", title: "Harbour Lights", artistName: "Test Band", albumTitle: "First Light", albumId: "alb-1" }}
        playing
        positionMs={60_000}
        durationMs={200_000}
        error={false}
        shuffle={false}
        repeat="off"
        canPrevious
        canNext
        labels={labels}
        onToggle={onToggle}
        onPrevious={vi.fn()}
        onNext={onNext}
        onShuffle={vi.fn()}
        onRepeat={vi.fn()}
        onSeek={onSeek}
        onOpen={vi.fn()}
        volume={null}
      />
    </>,
  );
  return { onToggle, onNext, onSeek };
}

/** Space on the focused element, with the browser's default action when no handler prevented it. */
function press(target: HTMLElement) {
  const down = fireEvent.keyDown(target, { key: " ", code: "Space" });
  if (down) {
    if (target instanceof HTMLButtonElement) target.click();
    else if (target instanceof HTMLInputElement) fireEvent.change(target, { target: { value: `${target.value} ` } });
    else if (target.isContentEditable) target.textContent = `${target.textContent ?? ""} `;
  }
  const up = fireEvent.keyUp(target, { key: " ", code: "Space" });
  log(`space on ${target.dataset.testid ?? target.tagName}: keydown ${down ? "kept" : "prevented"}, keyup ${up ? "kept" : "prevented"}`);
  return down;
}

/** A mouse click as the browser runs it: pointer down, focus, pointer up, click. */
function clickWithMouse(target: HTMLElement) {
  fireEvent.pointerDown(target);
  act(() => target.focus());
  fireEvent.pointerUp(target);
  target.click();
}

afterEach(cleanup);

// @req PAR-PLAY-11
describe("[parrot] space bar plays and pauses", () => {
  it("after a click on Next, space pauses instead of skipping again, and the clicked button loses its focus", () => {
    const { onToggle, onNext } = renderBar();
    const next = screen.getByTestId("player-next");
    clickWithMouse(next);
    log("after click", { onNext: onNext.mock.calls.length, focused: document.activeElement?.getAttribute("data-testid") });
    expect(onNext).toHaveBeenCalledTimes(1);

    expect(press(next)).toBe(false);
    log("after space", { onNext: onNext.mock.calls.length, onToggle: onToggle.mock.calls.length, focused: document.activeElement?.tagName });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    // Blurred, so the browser's keyboard heuristic draws no focus ring on a button the user only clicked.
    expect(document.activeElement).toBe(document.body);
  });

  it("after a click on the seek bar, space pauses and does not seek", () => {
    const { onToggle, onSeek } = renderBar();
    const seek = screen.getByTestId("player-seek");
    clickWithMouse(seek);
    const seeksAfterClick = onSeek.mock.calls.length;
    press(seek);
    log("seek bar", { seeksAfterClick, seeks: onSeek.mock.calls.length, onToggle: onToggle.mock.calls.length });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledTimes(seeksAfterClick);
  });

  it("keeps a button the keyboard focused: space plays or pauses, Enter still presses it", () => {
    const { onToggle, onNext } = renderBar();
    const next = screen.getByTestId("player-next");
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => next.focus());
    press(next);
    log("keyboard focus", { onToggle: onToggle.mock.calls.length, onNext: onNext.mock.calls.length, focused: document.activeElement?.getAttribute("data-testid") });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(next);

    // Enter on a focused button: the browser clicks it, and the shortcut leaves it alone.
    expect(fireEvent.keyDown(next, { key: "Enter" })).toBe(true);
    next.click();
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("types a space in a text field and in an editable area, without pausing", () => {
    const { onToggle } = renderBar();
    const field = screen.getByTestId<HTMLInputElement>("search-field");
    clickWithMouse(field);
    fireEvent.change(field, { target: { value: "linkin" } });
    expect(press(field)).toBe(true);
    const editor = screen.getByTestId("lyrics-editor");
    // jsdom does not compute isContentEditable from the attribute; a browser does.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    expect(press(editor)).toBe(true);
    log("typing", { field: field.value, editor: editor.textContent, onToggle: onToggle.mock.calls.length });
    expect(field.value).toBe("linkin ");
    expect(editor.textContent).toBe(" ");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("leaves space to an open dialog or menu", () => {
    const onConfirm = vi.fn();
    const { onToggle } = renderBar(
      <>
        <div role="dialog">
          <button type="button" data-testid="dialog-ok" onClick={onConfirm}>OK</button>
        </div>
        <div role="menu">
          <button type="button" role="menuitem" data-testid="menu-item" onClick={onConfirm}>Add to playlist</button>
        </div>
      </>,
    );
    press(screen.getByTestId("dialog-ok"));
    press(screen.getByTestId("menu-item"));
    log("dialog and menu", { onConfirm: onConfirm.mock.calls.length, onToggle: onToggle.mock.calls.length });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores space with a modifier and toggles once while the key is held", () => {
    const { onToggle } = renderBar();
    fireEvent.keyDown(document.body, { key: " ", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: " " });
    fireEvent.keyDown(document.body, { key: " ", repeat: true });
    fireEvent.keyDown(document.body, { key: " ", repeat: true });
    fireEvent.keyUp(document.body, { key: " " });
    log("modifier and held", { onToggle: onToggle.mock.calls.length });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the bar is gone (nothing loaded)", () => {
    const { onToggle } = renderBar();
    cleanup();
    fireEvent.keyDown(document.body, { key: " " });
    log("unmounted", { onToggle: onToggle.mock.calls.length });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
