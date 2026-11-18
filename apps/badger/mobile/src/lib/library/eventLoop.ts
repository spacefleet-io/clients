/**
 * Awaiting an already-settled promise only schedules a microtask, so a loop whose steps are synchronous under an
 * `await` (decrypting with react-native-quick-crypto, JSON.parse, SQL statement building) never lets the JS thread
 * serve touches or animation frames. Awaiting a macrotask does.
 */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Longest the JS thread may run in one piece inside a loop that yields (a frame is ~16 ms, the UI budget 100 ms). */
export const SLICE_BUDGET_MS = 20;
