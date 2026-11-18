import { useEffect, useState } from "react";

/** Runs `load` whenever `deps` change; the latest run wins. */
export const useQuery = <T>(load: () => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, loading: true }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error: error instanceof Error ? error.message : String(error), loading: false })
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
};
