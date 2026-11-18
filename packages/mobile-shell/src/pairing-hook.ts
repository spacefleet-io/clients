import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingClientCore, PairingPoll } from "@space/pairing-crypto";
import { abortableSleep } from "./pairing/sleep";
import { createPairingController, type PairingController, type PairingState } from "./pairing/controller";
import type { PairingCompletion } from "./pairing/completion";

export type UsePairingOptions = {
  /** The app's pairing client (device type and name); read once, on the first render. */
  client: PairingClientCore;
  /** Signs the device in with an approved pairing; the latest one is used, so it may close over fresh state. */
  complete: (approved: Extract<PairingPoll, { status: "approved" }>) => Promise<PairingCompletion>;
  /** Console log prefix, e.g. "tv.pairing"; defaults to "pairing". Read once, on the first render. */
  logTag?: string;
};

/** Pairing state for a sign-in screen: the code is requested on mount and forgotten on unmount. */
export const usePairing = ({ client, complete, logTag }: UsePairingOptions): { state: PairingState; restart: () => void } => {
  const [state, setState] = useState<PairingState>({ phase: "idle" });
  // `complete` usually closes over the auth store's session setter, whose identity changes with auth state; the
  // running controller must keep using the latest one.
  const completeRef = useRef(complete);
  completeRef.current = complete;

  const [controller] = useState<PairingController>(() =>
    createPairingController({
      client,
      complete: (approved) => completeRef.current(approved),
      onState: setState,
      now: () => Date.now(),
      sleep: abortableSleep,
      logTag,
    }),
  );

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  const restart = useCallback(() => controller.start(), [controller]);
  return { state, restart };
};
