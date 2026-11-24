// ACCT-PAIR-06: a pairing link (https://spacefleet.io/pair/<app>?code=...) can arrive before the user is signed in or
// before the library's navigator exists (a cold start through the link). The code waits here until the library is up,
// which opens the approve screen with it.
import { parsePairLink } from "@space/pairing-crypto";

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Holds the code of a pairing link; false (nothing held) when `url` is not one. */
export const holdPairLink = (url: string | null | undefined): boolean => {
  const link = url ? parsePairLink(url) : null;
  if (!link) return false;
  console.info("parrot.pair_link.held", JSON.stringify({ app: link.app }));
  pending = link.code;
  for (const listener of listeners) listener();
  return true;
};

/** The held code, handed over once. */
export const takePairLink = (): string | null => {
  const code = pending;
  pending = null;
  return code;
};

/** Called each time a link is held. */
export const onPairLink = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
