import { useCallback, useEffect, useRef, useState } from "react";
import { createAsyncAction, type AsyncActionOptions, type AsyncActionRunner } from "@space/shared";

type GlobalLoadingOptions = {
  title: string;
  subtitle?: string;
};

type LoadingModalAdapter = {
  showLoading: (options: GlobalLoadingOptions) => string;
  hideLoading: (token: string) => void;
};

export type UseAsyncActionOptions<Args extends unknown[], R> = {
  spinnerDelayMs?: number;
  minVisibleMs?: number;
  onError?: (error: unknown, args: Args) => void;
  onSuccess?: (result: R, args: Args) => void;
  globalLoading?:
    | GlobalLoadingOptions
    | ((...args: Args) => GlobalLoadingOptions);
  loadingModal?: LoadingModalAdapter;
};

export type UseAsyncActionResult<Args extends unknown[], R> = {
  trigger: (...args: Args) => Promise<R | undefined>;
  pending: boolean;
  spinnerVisible: boolean;
};

export function useAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: UseAsyncActionOptions<Args, R> = {},
): UseAsyncActionResult<Args, R> {
  const [pending, setPending] = useState(false);
  const [spinnerVisible, setSpinnerVisible] = useState(false);

  const fnRef = useRef(fn);
  const optionsRef = useRef(options);
  const lastArgsRef = useRef<Args | null>(null);
  useEffect(() => {
    fnRef.current = fn;
    optionsRef.current = options;
  });

  const loadingTokenRef = useRef<string | null>(null);
  const runnerRef = useRef<AsyncActionRunner<Args, R> | null>(null);

  const ensureRunner = useCallback(() => {
    if (runnerRef.current) return runnerRef.current;
    const coreOptions: AsyncActionOptions<Args, R> = {
      spinnerDelayMs: optionsRef.current.spinnerDelayMs,
      minVisibleMs: optionsRef.current.minVisibleMs,
      onPendingChange: (value) => setPending(value),
      onSpinnerChange: (visible) => {
        setSpinnerVisible(visible);
        const current = optionsRef.current;
        const adapter = current.loadingModal;
        const globalLoading = current.globalLoading;
        if (!adapter || !globalLoading) return;
        if (visible) {
          const resolved =
            typeof globalLoading === "function"
              ? globalLoading(...(lastArgsRef.current ?? ([] as unknown as Args)))
              : globalLoading;
          loadingTokenRef.current = adapter.showLoading(resolved);
        } else if (loadingTokenRef.current) {
          adapter.hideLoading(loadingTokenRef.current);
          loadingTokenRef.current = null;
        }
      },
      onError: (error, args) => {
        const current = optionsRef.current;
        if (current.onError) {
          current.onError(error, args);
        } else if (typeof console !== "undefined") {
          console.error("[useAsyncAction] unhandled error", error);
        }
      },
      onSuccess: (result, args) => {
        optionsRef.current.onSuccess?.(result, args);
      },
    };
    const runner = createAsyncAction<Args, R>(
      (...args: Args) => fnRef.current(...args),
      coreOptions,
    );
    runnerRef.current = runner;
    return runner;
  }, []);

  // Lazy-init on first render so the first trigger after mount works even
  // before the first effect has fired.
  if (runnerRef.current === null) ensureRunner();

  // StrictMode-safe lifecycle:
  //   * Initial mount → setup re-ensures runner (no-op if render created it).
  //   * Simulated unmount → cleanup disposes runner + nulls the ref.
  //   * Simulated remount → setup re-ensures runner (builds a fresh one).
  useEffect(() => {
    ensureRunner();
    return () => {
      if (loadingTokenRef.current && optionsRef.current.loadingModal) {
        optionsRef.current.loadingModal.hideLoading(loadingTokenRef.current);
        loadingTokenRef.current = null;
      }
      runnerRef.current?.dispose();
      runnerRef.current = null;
    };
  }, [ensureRunner]);

  const trigger = useCallback(
    (...args: Args) => {
      lastArgsRef.current = args;
      const runner = ensureRunner();
      return runner.trigger(...args);
    },
    [ensureRunner],
  );

  return { trigger, pending, spinnerVisible };
}
