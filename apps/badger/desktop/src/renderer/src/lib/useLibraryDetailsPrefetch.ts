import { useEffect, useRef } from "react";

/**
 * The details list shows seasons and runtime, which live in the per-title details cache. Fetches whatever the given
 * titles are missing through one worker, so fetches never overlap, and at most once per title (a failed fetch is not
 * retried: the row simply omits seasons / runtime).
 *
 * `items` and the callbacks are rebuilt on every render of the caller, so the effect depends on the ids missing details
 * as a string instead: it only runs again when that list really changes (a fetch landed, the page grew, the tab changed).
 */
export function useLibraryDetailsPrefetch(
  enabled: boolean,
  items: readonly { id: string }[],
  getDetails: (id: string) => unknown,
  fetchDetails: (id: string) => Promise<unknown>,
) {
  const missingKey = enabled
    ? items
        .filter((item) => !getDetails(item.id))
        .map((item) => item.id)
        .join("\n")
    : "";
  const fetchRef = useRef(fetchDetails);
  fetchRef.current = fetchDetails;
  const started = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // The newest list replaces whatever was still waiting (titles scrolled or switched away from are dropped).
    queue.current = missingKey === "" ? [] : missingKey.split("\n").filter((id) => !started.current.has(id));
    if (running.current || queue.current.length === 0) return;
    running.current = true;
    void (async () => {
      try {
        for (let id = queue.current.shift(); id !== undefined && mounted.current; id = queue.current.shift()) {
          started.current.add(id);
          try {
            await fetchRef.current(id);
          } catch {
            // Best effort: the row simply omits seasons / runtime.
          }
        }
      } finally {
        running.current = false;
      }
    })();
  }, [missingKey]);
}
