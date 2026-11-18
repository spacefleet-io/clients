/**
 * ACCT-SIGNIN-05 in a desktop app's window: the Google, Apple or Microsoft sign-in comes back through the app's
 * `<scheme>://auth/provider` link, main holds the outcome (`createProviderReturnMailbox` in
 * `@space/shared/providerSignIn`) and nudges the window; the sign-in screen pulls it over the preload bridge
 * (`ProviderReturnBridge`). Shared by Badger and Parrot desktop.
 */
import { useEffect, useRef } from "react";
import type { ProviderReturn, ProviderReturnBridge } from "@space/shared/providerSignIn";

const log = {
  info: (message: string, extra: Record<string, unknown>) => console.info(`[provider-sign-in] ${message}`, extra),
  warn: (message: string, extra: Record<string, unknown>) => console.warn(`[provider-sign-in] ${message}`, extra),
};

// The screen listening now, and an outcome taken while none was (a screen unmounted between the pull and its answer,
// as StrictMode's double mount does): main hands each outcome over once, so it must not be dropped here.
let currentHandler: ((outcome: ProviderReturn) => void) | null = null;
let unclaimed: ProviderReturn | null = null;

const deliver = (outcome: ProviderReturn) => {
  log.info("return taken", { outcome: "code" in outcome ? "code" : outcome.error, listening: currentHandler !== null });
  if (currentHandler) currentHandler(outcome);
  else unclaimed = outcome;
};

/**
 * Calls `onReturn` with each provider sign-in outcome main hands over: the one waiting when the screen mounts (the
 * window was created or still loading when the link came) and every later one. Each outcome arrives once.
 * `bridge` is read when the screen mounts; without one (a test window, a web build) nothing happens.
 */
export const useProviderReturn = (bridge: ProviderReturnBridge | undefined, onReturn: (outcome: ProviderReturn) => void) => {
  const latest = useRef(onReturn);
  latest.current = onReturn;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  useEffect(() => {
    const current = bridgeRef.current;
    if (!current) return;
    const handler = (outcome: ProviderReturn) => latest.current(outcome);
    currentHandler = handler;
    if (unclaimed !== null) {
      const outcome = unclaimed;
      unclaimed = null;
      handler(outcome);
    }
    const take = () => {
      current
        .takeReturn()
        .then((outcome) => {
          if (outcome !== null) deliver(outcome);
        })
        .catch((err: unknown) => log.warn("could not take the return", { error: err instanceof Error ? err.name : typeof err }));
    };
    take();
    const unsubscribe = current.onReturn(take);
    return () => {
      if (currentHandler === handler) currentHandler = null;
      unsubscribe();
    };
  }, []);
};

/**
 * For a screen that only starts sign-ins (sign-up): calls `onNudge` when an outcome comes back, without taking it, so
 * the sign-in screen it moves to takes it.
 */
export const useProviderReturnNudge = (bridge: ProviderReturnBridge | undefined, onNudge: () => void) => {
  const latest = useRef(onNudge);
  latest.current = onNudge;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  useEffect(() => bridgeRef.current?.onReturn(() => latest.current()), []);
};
