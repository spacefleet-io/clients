import { type ReactNode, useCallback, useState } from "react";

// Animation length kept in one place so the CSS `duration-200` transition on
// the wrapper finishes BEFORE the deferred remove action drops the row from
// the underlying data. Tweaking the visual duration must be paired with this
// constant — otherwise the row either snaps before fading or sticks around
// after the user has moved on.
export const DISMISS_ANIMATION_MS = 220;

type AnimatedDismissRowProps = {
  /** When true, the row collapses height + margin and slides + fades out. */
  removing: boolean;
  /** Optional extra classes for the inner card (e.g. existing border/bg styles). */
  innerClassName?: string;
  children: ReactNode;
};

/**
 * Wraps a list row so a "remove" interaction animates *both* the row and its
 * neighbours: the outer grid track collapses from `1fr` to `0fr` (so rows
 * below glide up over the same 220ms instead of snapping at unmount) and
 * the inner card slides + fades + scales for the "going away" cue.
 *
 * The `!mt-0` override is the load-bearing part: parents that compose rows
 * with `space-y-*` apply `margin-top` via a `:not(:first-child)` selector
 * whose specificity beats a plain `mt-0`. Without the `!important`, the
 * inter-row gap would not animate and the siblings would still snap.
 */
export function AnimatedDismissRow({ removing, innerClassName, children }: AnimatedDismissRowProps) {
  return (
    <div
      aria-hidden={removing || undefined}
      className={`grid transition-all duration-200 ease-in ${
        removing ? "!mt-0 grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
      }`}
    >
      <div className="overflow-hidden">
        <div
          className={`transition-transform duration-200 ease-in ${
            removing ? "translate-x-8 scale-95" : ""
          } ${innerClassName ?? ""}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

type DismissActions = {
  /** Set of ids currently animating out. Pass `dismissing.has(id)` to `<AnimatedDismissRow>`. */
  dismissing: ReadonlySet<string>;
  /** Mark `id` as dismissing, run `action` after the animation completes. */
  scheduleDismiss: (id: string, action: () => void) => void;
};

/**
 * State machine for animated row removal. The X-button handler should call
 * `scheduleDismiss(id, action)` instead of running `action` directly — the
 * hook flips `dismissing` immediately (so the CSS transition starts on the
 * next paint), then fires `action` after the animation finishes.
 *
 * The id stays pinned in `dismissing` even after `action` runs: we rely on
 * the consumer's data flow to actually unmount the row. Clearing the id at
 * `t=220` would cause a visible pop-back whenever `action` is async (e.g.
 * a runtime command that updates the snapshot 50-200ms later) because the
 * row would re-render with `removing=false` while the data still includes
 * it. The dismissing set grows monotonically until the consuming component
 * unmounts; ids are short and unique so the memory cost is negligible.
 */
export function useStaggeredDismiss(): DismissActions {
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set());

  const scheduleDismiss = useCallback((id: string, action: () => void) => {
    setDismissing((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      action();
    }, DISMISS_ANIMATION_MS);
  }, []);

  return { dismissing, scheduleDismiss };
}
