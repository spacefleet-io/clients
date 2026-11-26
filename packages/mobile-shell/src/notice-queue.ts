/**
 * The phone and TV shells' line of passing notices (UX-NOTICE-01, UX-NOTICE-03, UX-NOTICE-11): the shared queue from
 * `@space/notify-core/queue` with one card at a time (`MAX_VISIBLE.phone`), kept for the shell's lifetime. The overlay
 * components only draw what `current` holds. A repeat (same key) replaces the card where it stands, with a fresh timer;
 * `onDismiss` runs once per notice whatever ended it, which is where callers mark it seen. While held (a screen such as
 * the player covers the shell) nothing shows and no timer runs.
 */
import { useEffect, useMemo, useState } from "react";
import { createNoticeQueue, type NoticeQueueOptions } from "@space/notify-core/queue";

/** The queue for one shell. `keyOf`, `durationOf` and `onDismiss` may change between renders; the latest ones run. */
export const useNoticeQueue = <T>(options: NoticeQueueOptions<T>) => {
  const [latest] = useState(() => ({ options }));
  latest.options = options;
  const queue = useMemo(
    () =>
      createNoticeQueue<T>({
        ...latest.options,
        maxVisible: 1,
        keyOf: (item) => latest.options.keyOf(item),
        durationOf: latest.options.durationOf ? (item) => latest.options.durationOf?.(item) ?? null : undefined,
        onDismiss: (item, reason) => latest.options.onDismiss?.(item, reason),
      }),
    [latest],
  );
  const [current, setCurrent] = useState<T | null>(null);
  useEffect(() => {
    const unsubscribe = queue.subscribe(() => setCurrent(queue.current()));
    return () => {
      unsubscribe();
      queue.dispose();
    };
  }, [queue]);
  return { current, show: queue.show, dismiss: queue.dismiss, withdraw: queue.withdraw, setPaused: queue.setPaused, setHeld: queue.setHeld };
};
