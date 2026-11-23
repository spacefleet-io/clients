import { useEffect, useState } from "react";

/**
 * Runs `load` whenever `deps` change; the latest run wins. `data` stays the previous answer while the next run goes,
 * so a screen keeps what it shows; `answered` is true only once the run for the CURRENT `deps` has ended — also on the
 * render where `deps` just changed, before the effect starts the new run. A screen that turns "nothing" into a verdict
 * (the empty library, UX-WAIT-04) waits for it.
 */
export const useQuery = <T>(load: () => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; answeredFor: readonly unknown[] | null }>({
    data: null,
    error: null,
    loading: true,
    answeredFor: null,
  });
  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, loading: true }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false, answeredFor: deps }),
      (error) => live && setState({ data: null, error: error instanceof Error ? error.message : String(error), loading: false, answeredFor: deps })
    );
    return () => {
      live = false;
    };
  }, deps);
  const { answeredFor, ...query } = state;
  const answered =
    !query.loading && answeredFor !== null && answeredFor.length === deps.length && answeredFor.every((value, i) => Object.is(value, deps[i]));
  return { ...query, answered };
};
