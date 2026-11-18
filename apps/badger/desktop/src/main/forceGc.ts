import v8 from "node:v8";
import vm from "node:vm";

let collect: (() => void) | null = null;

/**
 * Run one full garbage collection in the main process.
 *
 * Buffers are off-heap: dropping the last reference does not return their memory to the OS until V8
 * collects the owning ArrayBuffer, and an idle main process (nothing allocating, so nothing triggering a
 * major GC) can hold a cleared cache for minutes. `--expose-gc` is turned on at runtime, so no launch
 * flag changes for packaged builds. Throws when V8 refuses the flag; the caller logs it.
 */
export function runFullGc(): { ms: number } {
  if (!collect) {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as unknown;
    if (typeof gc !== "function") throw new Error("gc_unavailable");
    collect = gc as () => void;
  }
  const startMs = Date.now();
  collect();
  return { ms: Date.now() - startMs };
}
