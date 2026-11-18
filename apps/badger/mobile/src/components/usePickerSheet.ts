import { useCallback, useMemo, useRef, useState } from "react";

export type PickerSheet = {
  visible: boolean;
  open: () => void;
  /** Hide the sheet (it slides out), then run `after` once it is out of sight (e.g. start what was picked). */
  close: (after?: () => void) => void;
  /** The sheet is out of sight: runs the `after` given to `close`. Pass it to the sheet's `onClosed`. */
  closed: () => void;
};

/** Open/closed state of a bottom picker sheet; `BottomSheet` (the shared sheet) owns the slide and the drag. */
export const usePickerSheet = (): PickerSheet => {
  const [visible, setVisible] = useState(false);
  const pendingAfter = useRef<(() => void) | undefined>(undefined);

  const open = useCallback(() => setVisible(true), []);

  const close = useCallback((after?: () => void) => {
    pendingAfter.current = after;
    setVisible(false);
  }, []);

  const closed = useCallback(() => {
    const after = pendingAfter.current;
    pendingAfter.current = undefined;
    after?.();
  }, []);

  return useMemo(() => ({ visible, open, close, closed }), [visible, open, close, closed]);
};
