import { useEffect } from "react";
import { Toaster, toast as sonnerToast, type ExternalToast } from "sonner";
import { durationFor, MAX_VISIBLE, NOTICE_TIMINGS, type JobOutcome, type NoticeKind } from "@space/notify-core/kinds";

/**
 * The passing notices of the computers and the web (UX-NOTICE-01, UX-NOTICE-03, UX-NOTICE-11), drawn by sonner:
 * - the time on screen comes from the notice's kind (`@space/notify-core`): a confirmation (`toast.success`) 4
 *   seconds, a heads-up 8, a notice with a button 8 with neither the pointer nor the focus on it; a caller cannot
 *   pick its own time, so nothing stays for good;
 * - a toast with the `id` of one on screen replaces it in place, with a fresh timer;
 * - the pointer or the keyboard focus on a toast holds it, and its full time starts again once both have left.
 */
export type NoticeToastOptions = Omit<ExternalToast, "duration" | "testId"> & {
  /** Default: `confirmation` for `toast.success`, `headsUp` for the others. */
  kind?: NoticeKind;
  outcome?: JobOutcome;
};

type Variant = "default" | "success" | "info" | "warning" | "error";
type Message = Parameters<typeof sonnerToast>[0];

type Live = {
  variant: Variant;
  message: Message;
  options: Omit<NoticeToastOptions, "kind" | "outcome">;
  base: number;
  pointer: boolean;
  focus: boolean;
  /** Bumped by a replace or a release: sonner restarts the timer only when the duration it is given changes. */
  generation: number;
};

const TEST_ID_PREFIX = "sf-notice-";
const live = new Map<string, Live>();
let counter = 0;

/** Time on screen for a toast of this variant and options, in ms (UX-NOTICE-03). */
export const toastDuration = (variant: Variant, options: Pick<NoticeToastOptions, "kind" | "outcome" | "action">): number => {
  if (options.action) return NOTICE_TIMINGS.actionIdleMs;
  const kind = options.kind ?? (variant === "success" ? "confirmation" : "headsUp");
  return durationFor({ kind, outcome: options.outcome }) ?? NOTICE_TIMINGS.headsUpMs;
};

const draw = (id: string, entry: Live) => {
  const held = entry.pointer || entry.focus;
  const options: ExternalToast = {
    ...entry.options,
    id,
    testId: `${TEST_ID_PREFIX}${id}`,
    duration: held ? Number.POSITIVE_INFINITY : entry.base + (entry.generation % 2),
    onAutoClose: (shown) => {
      live.delete(id);
      entry.options.onAutoClose?.(shown);
    },
    onDismiss: (shown) => {
      live.delete(id);
      entry.options.onDismiss?.(shown);
    },
  };
  if (entry.variant === "default") return sonnerToast(entry.message, options);
  return sonnerToast[entry.variant](entry.message, options);
};

const show = (variant: Variant, message: Message, options: NoticeToastOptions = {}) => {
  const { kind, outcome, ...rest } = options;
  const id = rest.id === undefined ? `t${++counter}` : String(rest.id);
  const previous = live.get(id);
  const entry: Live = {
    variant,
    message,
    options: rest,
    base: toastDuration(variant, { kind, outcome, action: rest.action }),
    pointer: previous?.pointer ?? false,
    focus: previous?.focus ?? false,
    generation: (previous?.generation ?? 0) + 1,
  };
  live.set(id, entry);
  return draw(id, entry);
};

const hold = (id: string, by: "pointer" | "focus", held: boolean) => {
  const entry = live.get(id);
  if (!entry || entry[by] === held) return;
  const wasHeld = entry.pointer || entry.focus;
  entry[by] = held;
  const isHeld = entry.pointer || entry.focus;
  if (wasHeld === isHeld) return;
  if (!isHeld) entry.generation += 1;
  draw(id, entry);
};

const toastIdOf = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) return null;
  const testId = target.closest("[data-sonner-toast]")?.getAttribute("data-testid");
  return testId?.startsWith(TEST_ID_PREFIX) ? testId.slice(TEST_ID_PREFIX.length) : null;
};

const watch = (enter: string, leave: string, by: "pointer" | "focus") => {
  const onEnter = (event: Event) => {
    const id = toastIdOf(event.target);
    if (id) hold(id, by, true);
  };
  const onLeave = (event: Event) => {
    const id = toastIdOf(event.target);
    const next = event instanceof MouseEvent || event instanceof FocusEvent ? toastIdOf(event.relatedTarget) : null;
    if (id && next !== id) hold(id, by, false);
  };
  document.addEventListener(enter, onEnter);
  document.addEventListener(leave, onLeave);
  return () => {
    document.removeEventListener(enter, onEnter);
    document.removeEventListener(leave, onLeave);
  };
};

export const toast = Object.assign((message: Message, options?: NoticeToastOptions) => show("default", message, options), {
  success: (message: Message, options?: NoticeToastOptions) => show("success", message, options),
  info: (message: Message, options?: NoticeToastOptions) => show("info", message, options),
  warning: (message: Message, options?: NoticeToastOptions) => show("warning", message, options),
  error: (message: Message, options?: NoticeToastOptions) => show("error", message, options),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
});

export type { ExternalToast };

export const Notifications = () => {
  useEffect(() => {
    const stopPointer = watch("pointerover", "pointerout", "pointer");
    const stopFocus = watch("focusin", "focusout", "focus");
    return () => {
      stopPointer();
      stopFocus();
    };
  }, []);
  return <Toaster closeButton position="top-right" offset={96} richColors expand={false} visibleToasts={MAX_VISIBLE.desktop} />;
};
