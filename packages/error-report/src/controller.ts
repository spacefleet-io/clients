/** One SDK behind the opt-in: `start` initialises it, `stop` shuts it down and drops anything unsent. */
export interface ReportingSdk {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface ErrorReporting {
  /** Applies the user's choice. Calling it with the current state does nothing. */
  setEnabled(enabled: boolean): Promise<void>;
  isEnabled(): boolean;
}

/**
 * Gate between the user's choice and an SDK. Until `setEnabled(true)` the SDK
 * is never started, so nothing is initialised and nothing is sent (REL-LOG-06).
 * Changes are applied one at a time, in order.
 */
export function createErrorReporting(sdk: ReportingSdk): ErrorReporting {
  let enabled = false;
  let queue: Promise<void> = Promise.resolve();
  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      const run = queue.then(async () => {
        if (next === enabled) return;
        if (next) await sdk.start();
        else await sdk.stop();
        enabled = next;
      });
      // A failed start or stop must not block the later choices, turning reporting off included.
      queue = run.catch(() => {});
      return run;
    },
  };
}
