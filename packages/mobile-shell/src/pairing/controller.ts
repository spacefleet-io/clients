/**
 * Drives a NEW device's pairing sign-in screen (Badger TV, Parrot phone): asks for a code, long-polls until
 * another app approves it, renews the code when it expires (the user may be looking away), and completes the
 * sign-in on approval (ACCT-PAIR-01).
 *
 * UI-free: the screen subscribes to `state` and the controller never touches React, timers or the network
 * except through injected functions, so every phase is unit-testable.
 */
import { PairingHttpError, type PairingClientCore, type PairingCreated, type PairingPoll } from "@space/pairing-crypto";
import { retryAfterSecondsToMinutes } from "@space/shared/signInError";
import type { PairingCompletion } from "./completion";

export type PairingFailure = "rate_limited" | "unreachable" | "failed" | "key_unreadable" | "key_mismatch";

export type PairingState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; request: PairingCreated; expiresAtMs: number; renewals: number }
  | { phase: "completing" }
  | { phase: "denied" }
  /** `retryAfterMinutes` (whole minutes, at least 1) comes with `rate_limited`: "Try again in N minutes" (ACCT-AUTH-11). */
  | { phase: "error"; reason: PairingFailure; retryAfterMinutes?: number }
  | { phase: "done" };

export type PairingControllerDeps = {
  client: PairingClientCore;
  complete: (approved: Extract<PairingPoll, { status: "approved" }>) => Promise<PairingCompletion>;
  onState: (state: PairingState) => void;
  now: () => number;
  /** Resolves after `ms`; resolves early (never rejects) when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Console log prefix, e.g. "tv.pairing"; defaults to "pairing". */
  logTag?: string;
};

/** A poll that returns faster than this was not held open by the API: wait before asking again. */
export const MIN_POLL_GAP_MS = 2_000;
/** Consecutive network failures tolerated (a TV may wake before Wi-Fi is back, a phone may switch networks) before showing an error. */
export const MAX_POLL_FAILURES = 4;
const POLL_FAILURE_BACKOFF_MS = 3_000;
/** A code that dies sooner than this (clock skew, API trouble) must not turn renewal into a request storm. */
export const MIN_RENEW_GAP_MS = 5_000;

export type PairingController = {
  /** Starts (or restarts) pairing with a fresh code. */
  start: () => void;
  /** Stops polling and forgets the code; the screen is leaving. */
  stop: () => void;
};

/** The error state a failed call ends in; a 429 carries the API's wait in whole minutes. */
const errorState = (error: unknown): Extract<PairingState, { phase: "error" }> => {
  if (error instanceof PairingHttpError) {
    if (error.status === 429) {
      return { phase: "error", reason: "rate_limited", retryAfterMinutes: retryAfterSecondsToMinutes(error.retryAfterSeconds) };
    }
    // No API error code: whatever answered is not the SpaceFleet API (a web page, a Wi-Fi login page), so this device
    // cannot reach the server; say that rather than "something went wrong" (ACCT-AUTH-11).
    if (error.code === null || error.code === "invalid_response") return { phase: "error", reason: "unreachable" };
    return { phase: "error", reason: "failed" };
  }
  // fetch() rejects with a TypeError / AbortError when the API cannot be reached.
  return { phase: "error", reason: "unreachable" };
};

export const createPairingController = (deps: PairingControllerDeps): PairingController => {
  const tag = `[${deps.logTag ?? "pairing"}]`;
  let run: AbortController | null = null;

  const stop = () => {
    run?.abort();
    run = null;
    deps.client.cancel();
  };

  const loop = async (signal: AbortSignal) => {
    const emit = (state: PairingState) => {
      if (!signal.aborted) {
        console.info(`${tag} state`, { phase: state.phase });
        deps.onState(state);
      }
    };

    let renewals = 0;
    emit({ phase: "starting" });

    while (!signal.aborted) {
      let request: PairingCreated;
      try {
        request = await deps.client.start();
      } catch (error) {
        console.warn(`${tag} start.failed`, { message: error instanceof Error ? error.message : String(error) });
        emit(errorState(error));
        return;
      }
      if (signal.aborted) return;
      const parsed = Date.parse(request.expiresAt);
      // An unparsable expiry must not make the loop renew forever: trust the API's own "expired" answer then.
      const expiresAtMs = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
      emit({ phase: "waiting", request, expiresAtMs, renewals });

      const issuedAt = deps.now();
      let failures = 0;
      let renew = false;
      while (!signal.aborted && !renew) {
        if (deps.now() >= expiresAtMs) {
          renew = true;
          break;
        }
        const startedAt = deps.now();
        let result: PairingPoll;
        try {
          result = await deps.client.poll(request.requestId);
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          failures += 1;
          console.warn(`${tag} poll.failed`, { failures, message: error instanceof Error ? error.message : String(error) });
          if (failures >= MAX_POLL_FAILURES) {
            emit(errorState(error));
            return;
          }
          await deps.sleep(POLL_FAILURE_BACKOFF_MS, signal);
          continue;
        }
        if (signal.aborted) return;

        switch (result.status) {
          case "pending": {
            const elapsed = deps.now() - startedAt;
            if (elapsed < MIN_POLL_GAP_MS) await deps.sleep(MIN_POLL_GAP_MS - elapsed, signal);
            break;
          }
          case "expired":
            renew = true;
            break;
          case "denied":
            emit({ phase: "denied" });
            return;
          case "key_unreadable":
            emit({ phase: "error", reason: "key_unreadable" });
            return;
          case "approved": {
            emit({ phase: "completing" });
            const completion = await deps.complete(result);
            if (signal.aborted) return;
            if (completion.ok) {
              emit({ phase: "done" });
            } else {
              emit({ phase: "error", reason: completion.reason === "key_mismatch" ? "key_mismatch" : "failed" });
            }
            return;
          }
        }
      }

      if (signal.aborted) return;
      renewals += 1;
      const lived = deps.now() - issuedAt;
      if (lived < MIN_RENEW_GAP_MS) await deps.sleep(MIN_RENEW_GAP_MS - lived, signal);
      console.info(`${tag} renew`, { renewals, previous: request.requestId });
    }
  };

  const start = () => {
    stop();
    const controller = new AbortController();
    run = controller;
    void loop(controller.signal);
  };

  return { start, stop };
};
