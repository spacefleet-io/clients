import { useRef } from "react";

/**
 * @bugfix #2461 @regression-proof
 *
 * `next`, or the value this hook returned last render when `reuse` says nothing in it changed. Lets a component
 * keep a derived Set or Map referentially stable across store ticks that rebuild it with the same contents, so the
 * memos and memoised children keyed on it skip their work (see `reuseSameIdSet` / `reuseUnchangedActiveJobStates`).
 *
 * It lives in its own module on purpose: the ref it reads and writes during render makes the React Compiler skip
 * the function that does so, and that must be this small hook, not the page that calls it.
 */
export const useContentStable = <T>(next: T, reuse: (prev: T | null, next: T) => T): T => {
  const previous = useRef<T | null>(null);
  // The ref holds only the last returned value; `reuse` compares contents, so a value from a render React threw
  // away is still a correct value to return.
  /* eslint-disable react-hooks/refs -- keeping the previous value is this hook's whole job (see above) */
  previous.current = reuse(previous.current, next);
  return previous.current;
  /* eslint-enable react-hooks/refs */
};
