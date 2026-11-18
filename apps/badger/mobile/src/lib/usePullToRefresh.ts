import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";

/**
 * Holds a pull-to-refresh trigger until the finger is lifted.
 *
 * iOS's native refresh control fires as soon as the pull crosses its threshold,
 * finger still down. The gate records that trigger while a drag is in progress
 * and fires on drag end instead. Android's SwipeRefreshLayout already fires on
 * release only, so the hook does not wire the gate there.
 */
export const createPullReleaseGate = (fire: () => void) => {
  let dragging = false;
  let armed = false;
  return {
    beginDrag() {
      dragging = true;
    },
    /** Returns true when the refresh fired now, false when it waits for release. */
    trigger(): boolean {
      if (dragging) {
        armed = true;
        return false;
      }
      fire();
      return true;
    },
    endDrag() {
      dragging = false;
      if (!armed) return;
      armed = false;
      fire();
    },
  };
};

/** What a list needs to offer pull-to-refresh; see `usePullToRefresh`. */
export type PullToRefresh = {
  refreshing: boolean;
  onRefresh: () => void;
  /** Set on iOS only: the list reports its drags so the refresh waits for release. */
  onDragBegin?: () => void;
  onDragEnd?: () => void;
};

type DragHandlers = { onScrollBeginDrag?: () => void; onScrollEndDrag?: () => void };

/**
 * Drives a RefreshControl from an async `refresh()`: the spinner shows from the
 * moment the finger is released until `refresh()` settles (and at least `minMs`
 * passed so the gesture never flickers). The list that owns the RefreshControl
 * merges the drag handlers through `usePullRefreshScroll`.
 */
export const usePullToRefresh = (refresh: () => Promise<void>, minMs = 700): PullToRefresh => {
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const gate = useMemo(
    () =>
      createPullReleaseGate(() => {
        const startedAt = Date.now();
        setRefreshing(true);
        void refreshRef
          .current()
          .catch((error: unknown) => {
            console.warn("library.pull_refresh.failed", JSON.stringify({ error: String(error) }));
          })
          .finally(() => {
            const wait = Math.max(0, minMs - (Date.now() - startedAt));
            setTimeout(() => {
              if (mounted.current) setRefreshing(false);
            }, wait);
          });
      }),
    [minMs],
  );

  const onRefresh = useCallback(() => {
    gate.trigger();
  }, [gate]);

  return useMemo(
    () =>
      Platform.OS === "ios"
        ? { refreshing, onRefresh, onDragBegin: gate.beginDrag, onDragEnd: gate.endDrag }
        : { refreshing, onRefresh },
    [refreshing, onRefresh, gate],
  );
};

/** The list's own scroll handlers (sky covers) plus the pull-to-refresh drag tracking. */
export const usePullRefreshScroll = <T extends DragHandlers>(pull: PullToRefresh | undefined, handlers: T): T => {
  const onDragBegin = pull?.onDragBegin;
  const onDragEnd = pull?.onDragEnd;
  return useMemo(() => {
    if (!onDragBegin || !onDragEnd) return handlers;
    return {
      ...handlers,
      onScrollBeginDrag: () => {
        handlers.onScrollBeginDrag?.();
        onDragBegin();
      },
      onScrollEndDrag: () => {
        handlers.onScrollEndDrag?.();
        onDragEnd();
      },
    };
  }, [handlers, onDragBegin, onDragEnd]);
};
