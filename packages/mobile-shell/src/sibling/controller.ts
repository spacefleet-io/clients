/**
 * Same-device sign-in, the ASKING phone app (ACCT-PAIR-07): Parrot signs in through a signed-in Badger on the same
 * phone, or the reverse. It opens an ordinary pairing request (its own session and device entry, ACCT-PAIR-01), hands
 * the code to the sister app, which asks the user and answers with the library key sealed to this request, delivers
 * that key to the pairing client and polls until the API's approval is in too, then completes exactly like a paired
 * sign-in. The approved account must be the one the sister app is signed in to: a leaked code approved by someone
 * else's account is refused.
 *
 * UI-free like `../pairing/controller`: React, timers, the native channel and the network come in as functions.
 */
import { checkSiblingAccount, isSealedKey, type PairingClientCore, type PairingPoll, type SealedKey } from "@space/pairing-crypto";
import type { PairingCompletion } from "../pairing/completion";
import { MIN_POLL_GAP_MS } from "../pairing/controller";

/** No answer from the sister app (or the API) within two minutes: give up and offer the other ways to sign in. */
export const SIBLING_SIGN_IN_TIMEOUT_MS = 120_000;

/**
 * What the sister app answered, over the local channel (`requestSiblingApproval`), the same shape on Android and iOS.
 * `approverUserId`/`approverEmail`: the account the sister app had published when it answered, read by the native side
 * from the sister's own signature-protected status (never from the answer's sender).
 */
export type SiblingApprovalAnswer =
  | { result: "approved"; sealedKey: string; approverUserId: string; approverEmail: string }
  | { result: "cancelled" }
  | { result: "error"; message?: string };

/** `idle`: the offer shows. `failed` shows "{Other} could not sign you in. Sign in another way." */
export type SiblingSignInState =
  | { phase: "idle" }
  | { phase: "waiting" }
  | { phase: "completing" }
  | { phase: "failed"; reason: string }
  | { phase: "done" };

export type SiblingSignInControllerDeps = {
  client: PairingClientCore;
  approve: (request: { requestId: string; shortCode: string }) => Promise<SiblingApprovalAnswer>;
  complete: (approved: Extract<PairingPoll, { status: "approved" }>) => Promise<PairingCompletion>;
  onState: (state: SiblingSignInState) => void;
  now: () => number;
  /** Resolves after `ms`; resolves early (never rejects) when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  logTag?: string;
};

export type SiblingSignInController = {
  /** "Continue as …": opens the request and asks the sister app. */
  start: () => void;
  /** Cancel in this app while waiting: forgets the request, back to the offer. */
  cancel: () => void;
  /** The screen is leaving: forgets the request, no state. */
  stop: () => void;
};

const parseSealedKey = (raw: string): SealedKey | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSealedKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const createSiblingSignInController = (deps: SiblingSignInControllerDeps): SiblingSignInController => {
  const tag = `[${deps.logTag ?? "sibling"}]`;
  let run: AbortController | null = null;

  const abort = () => {
    run?.abort();
    run = null;
    deps.client.cancel();
  };

  const flow = async (signal: AbortSignal) => {
    const emit = (state: SiblingSignInState) => {
      if (signal.aborted) return;
      console.info(`${tag} state`, state);
      deps.onState(state);
    };
    const fail = (reason: string) => {
      if (signal.aborted) return;
      console.warn(`${tag} failed`, { reason });
      emit({ phase: "failed", reason });
      abort();
    };
    let completing = false;
    void deps.sleep(SIBLING_SIGN_IN_TIMEOUT_MS, signal).then(() => {
      if (!completing) fail("timeout");
    });

    emit({ phase: "waiting" });
    let request: { requestId: string; shortCode: string };
    try {
      request = await deps.client.start();
    } catch (error) {
      console.warn(`${tag} start.failed`, { message: error instanceof Error ? error.message : String(error) });
      fail("start_failed");
      return;
    }
    if (signal.aborted) return;

    const answer = await deps.approve({ requestId: request.requestId, shortCode: request.shortCode });
    if (signal.aborted) return;
    console.info(`${tag} answer`, { result: answer.result });
    if (answer.result === "cancelled") {
      emit({ phase: "idle" });
      abort();
      return;
    }
    if (answer.result !== "approved") {
      fail(answer.message || "failed");
      return;
    }
    const sealed = parseSealedKey(answer.sealedKey);
    if (!sealed || !deps.client.deliverLocalKey(request.requestId, sealed)) {
      fail("key_unreadable");
      return;
    }

    while (!signal.aborted) {
      const startedAt = deps.now();
      let result: PairingPoll;
      try {
        result = await deps.client.poll(request.requestId);
      } catch (error) {
        console.warn(`${tag} poll.failed`, { message: error instanceof Error ? error.message : String(error) });
        await deps.sleep(MIN_POLL_GAP_MS, signal);
        continue;
      }
      if (signal.aborted) return;
      if (result.status === "pending") {
        const elapsed = deps.now() - startedAt;
        if (elapsed < MIN_POLL_GAP_MS) await deps.sleep(MIN_POLL_GAP_MS - elapsed, signal);
        continue;
      }
      if (result.status !== "approved") {
        fail(result.status);
        return;
      }
      if (!checkSiblingAccount(result.user, { userId: answer.approverUserId, email: answer.approverEmail })) {
        fail("wrong_account");
        return;
      }
      completing = true;
      emit({ phase: "completing" });
      const completion = await deps.complete(result);
      if (signal.aborted) return;
      if (completion.ok) {
        emit({ phase: "done" });
        run = null;
      } else {
        fail(completion.reason);
      }
      return;
    }
  };

  return {
    start: () => {
      // A previous run's request is replaced by the client's own start(); only its loop must stop.
      run?.abort();
      const controller = new AbortController();
      run = controller;
      void flow(controller.signal);
    },
    cancel: () => {
      if (!run) return;
      console.info(`${tag} cancel`);
      abort();
      deps.onState({ phase: "idle" });
    },
    stop: abort,
  };
};
