import { useEffect, useRef } from "react";
import { Linking } from "react-native";
import { handOffProviderReturn } from "../provider-sign-in";
import type { PendingPairLink } from "./pairLink";

/**
 * The phone's incoming links, from the link that started the app or one that arrives while it runs: the browser back
 * from Google, Apple or Microsoft (`<scheme>://auth/provider`, ACCT-SIGNIN-05) goes to the sign-in screen; a pairing
 * link (ACCT-PAIR-06) is held in `pending` until the app can open its approve screen (`useHeldPairLink`).
 */
export const usePairLinkIntake = (scheme: string, pending: PendingPairLink): void => {
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (handOffProviderReturn(scheme, url)) return;
      pending.hold(url);
    };
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => undefined);
    const subscription = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => subscription.remove();
  }, [scheme, pending]);
};

/**
 * Opens the approve screen with a held pairing code once `ready` (signed in, navigator mounted): the one held before,
 * then each one that arrives while ready. The code is handed over once.
 */
export const useHeldPairLink = (pending: PendingPairLink, ready: boolean, open: (code: string) => void): void => {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!ready) return;
    const flush = () => {
      const code = pending.take();
      if (code) openRef.current(code);
    };
    flush();
    return pending.onHeld(flush);
  }, [pending, ready]);
};
