/**
 * Structural equality for IPC-cloned plain data (objects, arrays, primitives).
 * Library snapshots reach the renderer as fresh structured clones, so reference
 * equality always reports a change; this tells a real change from a no-op push
 * (#25 P1). Lives in its own module so it bundles with its lazy consumers, not
 * into the budgeted AuthenticatedApp chunk.
 */
export const plainDataEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!plainDataEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!plainDataEqual(Reflect.get(a, key), Reflect.get(b, key))) return false;
  }
  return true;
};
