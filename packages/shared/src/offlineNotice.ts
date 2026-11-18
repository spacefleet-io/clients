/**
 * When to say "offline" in a passing notice (UX-NOTICE-02), one rule for Badger's phone and computer. Offline is a
 * normal state, shown by a small lasting sign; the notice that floats over the page and leaves on its own is said once
 * when the app goes offline (or the cause changes), taken back when the connection returns, and never repeated while
 * the state stays the same. Each app owns its offline signal and its notice; it passes the previous and the current
 * cause (`null` = online) and acts on the answer.
 */
export type OfflineNoticeEdge<V extends string> = { kind: "show"; variant: V } | { kind: "withdraw" } | null;

export const offlineNoticeEdge = <V extends string>(previous: V | null, next: V | null): OfflineNoticeEdge<V> => {
  if (next === previous) return null;
  return next === null ? { kind: "withdraw" } : { kind: "show", variant: next };
};
