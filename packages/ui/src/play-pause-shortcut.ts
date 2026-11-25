import { useEffect, useRef } from "react";

/** Inputs where space presses rather than types: the clickable and the range ones. Every other type takes it as a character. */
const PRESSED_INPUT_TYPES: Record<string, true> = { button: true, submit: true, reset: true, image: true, checkbox: true, radio: true, range: true, color: true, file: true };

/** Inside these, space belongs to the widget: picking a menu item, an option, or a button of an open dialog. */
const SPACE_OWNERS = "[role=dialog],[role=alertdialog],[role=menu],[role=menubar],[role=listbox],[role=combobox],[role=textbox],[role=searchbox],[role=spinbutton]";

/** True when space typed at `target` has its own meaning there: a character in a field or a choice in a dialog or menu. */
export function spaceBelongsTo(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return PRESSED_INPUT_TYPES[target.type] !== true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(SPACE_OWNERS) !== null;
}

/**
 * Space plays or pauses anywhere in the window while `enabled` (PAR-PLAY-11), instead of pressing the focused button
 * or slider again: after a click on Next, space must not skip once more. Fields, dialogs and menus keep their space.
 *
 * Listens in the capture phase so it runs before the focused control's own handlers, and swallows the keyup as well
 * (some browsers press a button on keyup). A control the pointer focused is blurred, so the browser's
 * keyboard-focus heuristic does not draw a ring on a button the user only clicked; a control the keyboard
 * focused (Tab) keeps its focus and ring, and Enter still presses it.
 */
export function usePlayPauseShortcut(onToggle: () => void, enabled = true) {
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(() => {
    if (!enabled) return;
    let pointerDown = false;
    let pointerFocused: EventTarget | null = null;
    let swallowKeyUp = false;
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onFocusIn = (event: FocusEvent) => {
      pointerFocused = pointerDown ? event.target : null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      pointerDown = false;
      if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
      if (event.defaultPrevented || spaceBelongsTo(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      swallowKeyUp = true;
      if (event.repeat) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused === pointerFocused) focused.blur();
      toggle.current();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== " " || !swallowKeyUp) return;
      swallowKeyUp = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [enabled]);
}
