export type AsyncActionCallbacks<Args extends unknown[], R> = {
  onPendingChange?: (pending: boolean) => void;
  onSpinnerChange?: (visible: boolean) => void;
  onError?: (error: unknown, args: Args) => void;
  onSuccess?: (result: R, args: Args) => void;
};

export type AsyncActionOptions<Args extends unknown[], R> = AsyncActionCallbacks<Args, R> & {
  spinnerDelayMs?: number;
  minVisibleMs?: number;
};

export type AsyncActionRunner<Args extends unknown[], R> = {
  trigger: (...args: Args) => Promise<R | undefined>;
  dispose: () => void;
  isPending: () => boolean;
};

export const DEFAULT_SPINNER_DELAY_MS = 400;
export const DEFAULT_MIN_VISIBLE_MS = 250;

export function createAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: AsyncActionOptions<Args, R> = {},
): AsyncActionRunner<Args, R> {
  const spinnerDelayMs = options.spinnerDelayMs ?? DEFAULT_SPINNER_DELAY_MS;
  const minVisibleMs = options.minVisibleMs ?? DEFAULT_MIN_VISIBLE_MS;

  let pending = false;
  let disposed = false;
  let currentTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimeout = () => {
    if (currentTimeout !== null) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }
  };

  const safe = <T extends (...args: never[]) => void>(cb: T | undefined) =>
    (...args: Parameters<T>) => {
      if (disposed) return;
      cb?.(...args);
    };

  const setPending = safe(options.onPendingChange);
  const setSpinner = safe(options.onSpinnerChange);
  const reportError = (err: unknown, args: Args) => {
    if (disposed) return;
    options.onError?.(err, args);
  };
  const reportSuccess = (result: R, args: Args) => {
    if (disposed) return;
    options.onSuccess?.(result, args);
  };

  const trigger = async (...args: Args): Promise<R | undefined> => {
    if (disposed || pending) return undefined;

    pending = true;
    setPending(true);

    let spinnerShownAt: number | null = null;
    clearPendingTimeout();
    currentTimeout = setTimeout(() => {
      currentTimeout = null;
      if (disposed || !pending) return;
      spinnerShownAt = Date.now();
      setSpinner(true);
    }, spinnerDelayMs);

    let result: R | undefined;
    let caught: { error: unknown } | null = null;
    try {
      result = await fn(...args);
    } catch (error) {
      caught = { error };
    }

    clearPendingTimeout();

    if (spinnerShownAt !== null) {
      const elapsed = Date.now() - spinnerShownAt;
      if (elapsed < minVisibleMs) {
        await new Promise<void>((resolve) => {
          const remaining = minVisibleMs - elapsed;
          const id = setTimeout(() => resolve(), remaining);
          if (disposed) {
            clearTimeout(id);
            resolve();
          }
        });
      }
    }

    pending = false;
    if (spinnerShownAt !== null) setSpinner(false);
    setPending(false);

    if (caught) {
      reportError(caught.error, args);
      return undefined;
    }
    reportSuccess(result as R, args);
    return result;
  };

  return {
    trigger,
    isPending: () => pending,
    dispose: () => {
      disposed = true;
      clearPendingTimeout();
      pending = false;
    },
  };
}
