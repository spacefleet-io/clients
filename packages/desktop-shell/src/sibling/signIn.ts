/**
 * ACCT-PAIR-07: the ASKING side of same-device sign-in on a computer. A signed-out Parrot (or Badger) whose sister app
 * is signed in on this computer opens an ordinary pairing request (its own session and device entry, ACCT-PAIR-01),
 * hands the code to the sister app over the local channel, opens the key it gets back sealed for that request, and
 * polls until the API's approval is in too. The window then finishes exactly as after a paired sign-in.
 *
 * Cancel, or two minutes without an answer, drops the request and asks the sister app to deny it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { checkSiblingAccount, siblingAppOf, type SealedKey } from "@space/pairing-crypto";
import type { SpaceAppId } from "@space/shared/appScope";
import type { PairingPoll } from "../pairing/types";
import { askSibling, type SiblingAnswer, type SiblingAskInput } from "./channel";
import type { SiblingPlace } from "./place";
import { readSiblingOffer, readSiblingStatus } from "./status";
import type { SiblingOffer, SiblingSignInResult } from "./types";

type Log = (message: string, extra?: Record<string, unknown>) => void;

/** The new-device pairing client (`createDesktopPairingClient`, or the shared core). */
export type SiblingPairing = {
  start: () => Promise<{ requestId: string; shortCode: string }>;
  poll: (requestId: string) => Promise<PairingPoll>;
  cancel: () => void;
  deliverLocalKey: (requestId: string, sealed: SealedKey) => boolean;
};

export type SiblingSignInOptions = {
  place: SiblingPlace;
  /** The app asking to be signed in. */
  app: SpaceAppId;
  pairing: SiblingPairing;
  log?: Log;
  timeoutMs?: number;
  /** Pause between two "pending" polls (the API's long poll usually waits on its own). */
  pollGapMs?: number;
  ask?: (input: SiblingAskInput) => Promise<SiblingAnswer>;
};

export type SiblingSignIn = {
  offer: () => SiblingOffer | null;
  signIn: () => Promise<SiblingSignInResult>;
  cancel: () => void;
};

export const SIBLING_SIGN_IN_TIMEOUT_MS = 120_000;

type Stop = { stop: "cancelled" | "timeout" };

export const createSiblingSignIn = (options: SiblingSignInOptions): SiblingSignIn => {
  const { place, app, pairing } = options;
  const log: Log = options.log ?? (() => undefined);
  const ask = options.ask ?? askSibling;
  let stopCurrent: ((stop: Stop) => void) | null = null;

  const signIn = async (): Promise<SiblingSignInResult> => {
    stopCurrent?.({ stop: "cancelled" });
    const stopped = Promise.withResolvers<Stop>();
    stopCurrent = stopped.resolve;
    const timer = setTimeout(() => stopped.resolve({ stop: "timeout" }), options.timeoutMs ?? SIBLING_SIGN_IN_TIMEOUT_MS);
    /** The step's value, its error, or why the whole sign-in stopped first. */
    const until = <T>(step: Promise<T>) =>
      Promise.race([step.then((value) => ({ value }), (error: unknown) => ({ error })), stopped.promise]);
    let request: { requestId: string; shortCode: string } | null = null;

    const giveUp = (reason: string, status: "failed" | "cancelled"): SiblingSignInResult => {
      log("sibling sign-in: stopped", { reason, requestId: request?.requestId ?? null });
      pairing.cancel();
      if (request) {
        // Best effort: the sister app denies the request so a late approval cannot sign this app in.
        void ask({ place, asker: app, op: "refuse", requestId: request.requestId, code: request.shortCode, log, spawn: () => undefined, connectTimeoutMs: 2_000, answerTimeoutMs: 10_000 }).catch(
          () => undefined,
        );
      }
      return { status };
    };
    const ended = (stop: Stop) => giveUp(stop.stop, stop.stop === "cancelled" ? "cancelled" : "failed");

    try {
      const sister = siblingAppOf(app);
      const status = sister ? readSiblingStatus(place, sister) : null;
      const expected = status ? { userId: status.userId, email: status.email } : null;
      if (!expected) return giveUp("no signed-in sister app", "failed");
      const started = await until(pairing.start());
      if ("stop" in started) return ended(started);
      if ("error" in started) return giveUp("pairing request refused", "failed");
      request = started.value;
      log("sibling sign-in: request opened", { requestId: request.requestId, app });

      const asked = await until(ask({ place, asker: app, op: "approve", requestId: request.requestId, code: request.shortCode, log }));
      if ("stop" in asked) return ended(asked);
      if ("error" in asked || !asked.value.ok || !asked.value.sealedKey) return giveUp("sister app did not approve", "failed");
      if (!pairing.deliverLocalKey(request.requestId, asked.value.sealedKey)) return giveUp("key from the sister app does not open", "failed");

      for (;;) {
        const polled = await until(pairing.poll(request.requestId));
        if ("stop" in polled) return ended(polled);
        if ("error" in polled) return giveUp("poll failed", "failed");
        if (polled.value.status === "approved") {
          // A squatter answering in the sister app's place could approve with another account: take only the one
          // the sister app says it is signed in with.
          if (!checkSiblingAccount(polled.value.user, expected)) return giveUp("approved for another account", "failed");
          log("sibling sign-in: approved", { requestId: request.requestId });
          return polled.value;
        }
        if (polled.value.status !== "pending") return giveUp(`request ${polled.value.status}`, "failed");
        const paused = await until(sleep(options.pollGapMs ?? 1_000));
        if ("stop" in paused) return ended(paused);
      }
    } finally {
      clearTimeout(timer);
      if (stopCurrent === stopped.resolve) stopCurrent = null;
    }
  };

  return {
    offer: () => readSiblingOffer(place, app),
    signIn,
    cancel: () => stopCurrent?.({ stop: "cancelled" }),
  };
};
