// ACCT-PAIR-06: a pairing link (https://spacefleet.io/pair/<app>?code=...) can arrive before the user is signed in or
// before the app's navigator exists (a cold start through the link). Its code waits here until the app can open the
// approve screen with it. Shared by Badger's and Parrot's phones (quality audit #3350, S21); pure, so it tests without
// a device.
import { parseLegacyPairLink, parsePairLink } from "@space/pairing-crypto";
import { scopeLogger } from "../logger";

const log = scopeLogger("pairing.link");

export type PendingPairLink = {
  /** Holds the code of a pairing link; false (nothing held) when `url` is not one. */
  hold: (url: string | null | undefined) => boolean;
  /** The held code, handed over once. */
  take: () => string | null;
  /** Called each time a link is held; returns the unsubscribe. */
  onHeld: (listener: () => void) => () => void;
};

/**
 * One app's held pairing link. Both apps take either app's link (a Badger device is approved from Parrot too,
 * ACCT-PAIR-05). `legacy` also reads `spacebadger://pair?code=`, the QR of desktops released before the web link: only
 * Badger claims that scheme, until those desktops are below the minimum supported version (REL-CD-08).
 */
export const createPendingPairLink = ({ legacy = false }: { legacy?: boolean } = {}): PendingPairLink => {
  let pending: string | null = null;
  const listeners = new Set<() => void>();
  return {
    hold: (url) => {
      if (!url) return false;
      const link = parsePairLink(url);
      const code = link?.code ?? (legacy ? parseLegacyPairLink(url) : null);
      if (!code) return false;
      log.info("held", { app: link?.app ?? "legacy" });
      pending = code;
      for (const listener of listeners) listener();
      return true;
    },
    take: () => {
      const code = pending;
      pending = null;
      return code;
    },
    onHeld: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
