/**
 * Single source of truth for whether engineV2 booted. Read by route handlers
 * and module dispatchers so a missing engineV2 produces an explicit, typed
 * 503-shaped error envelope instead of silent fallback. Mutated only by the
 * runtime bootstrap (`apps/runtime/src/index.ts`).
 *
 * Status semantics:
 * - `not_booted`: engineV2 has not been started yet (process startup window).
 * - `disabled`: `RUNTIME_ENGINE_V2` was set to a falsy value; user opted out.
 * - `boot_failed`: V2 was enabled but `engineV2.start()` (or its setup) threw.
 * - `ready`: engineV2 is live.
 */

export type EngineV2BootStatus =
  | { state: "not_booted" }
  | { state: "disabled" }
  | { state: "boot_failed"; message: string }
  | { state: "ready" };

let current: EngineV2BootStatus = { state: "not_booted" };

export const setEngineV2BootStatus = (status: EngineV2BootStatus): void => {
  current = status;
};

export const getEngineV2BootStatus = (): EngineV2BootStatus => current;

/** Test-only reset — not exported from the package barrel. */
export const __resetEngineV2BootStatusForTests = (): void => {
  current = { state: "not_booted" };
};

export const ENGINE_V2_DISABLED_ERROR = {
  error: "engine_v2_disabled" as const,
  message:
    "Set RUNTIME_ENGINE_V2=1 (default) and restart the runtime",
};

export const buildEngineV2BootFailedError = (message: string) => ({
  error: "engine_v2_boot_failed" as const,
  message,
});

export const buildEngineV2NotReadyError = () => ({
  error: "engine_v2_not_ready" as const,
  message:
    "EngineV2 is initializing — retry shortly. If this persists, check the runtime log for boot errors.",
});

/**
 * Resolve the appropriate error envelope for a request that requires engineV2
 * but found no live handler. Returns `null` when engineV2 is ready (caller
 * should then proceed; null path indicates an unexpected race).
 */
export const resolveEngineV2UnavailableError = ():
  | { error: string; message: string }
  | null => {
  const status = getEngineV2BootStatus();
  switch (status.state) {
    case "ready":
      return null;
    case "disabled":
      return ENGINE_V2_DISABLED_ERROR;
    case "boot_failed":
      return buildEngineV2BootFailedError(status.message);
    case "not_booted":
    default:
      return buildEngineV2NotReadyError();
  }
};
