/**
 * @test-id MOBILE-SHELL-SIBLING-CONTROLLER-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile,parrot]
 * @why On a phone where Badger (or Parrot) is signed in, its sister app signs in with "Continue as …": it opens an
 *   ordinary pairing request, hands the code to the sister app, takes the sealed key back over the same local channel
 *   and finishes exactly like a paired sign-in. Every way out (allowed, cancelled in the sister app, refused, failed,
 *   two minutes without an answer) must end in the right state, and a failure must forget the pairing request.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { PairingClientCore, PairingPoll, SealedKey } from "@space/pairing-crypto";
import {
  createSiblingSignInController,
  SIBLING_SIGN_IN_TIMEOUT_MS,
  type SiblingApprovalAnswer,
  type SiblingSignInState,
} from "../src/sibling/controller";

const SUITE = "[sibling-controller]";
// The shape a real sealed key has (X25519 public key, AES-GCM nonce, 32-byte key + tag); the controller checks it.
const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
const SEALED: SealedKey = { v: 1, epk: b64(32), iv: b64(12), ct: b64(48) };
const APPROVED: Extract<PairingPoll, { status: "approved" }> = {
  status: "approved",
  token: "tok",
  user: { id: "u1", email: "ada@example.com" },
  libraryKey: "a2V5",
};

const APPROVER = { approverUserId: "u1", approverEmail: "ada@example.com" };

type Harness = {
  states: SiblingSignInState[];
  client: { [K in keyof PairingClientCore]: Mock };
  approve: Mock;
  complete: Mock;
  fireTimeout: () => void;
  start: () => void;
  cancel: () => void;
  stop: () => void;
  settled: () => Promise<void>;
};

const harness = (opts: {
  answer?: Promise<SiblingApprovalAnswer> | SiblingApprovalAnswer;
  polls?: PairingPoll[];
  deliver?: boolean;
  startError?: Error;
  completion?: { ok: true } | { ok: false; reason: string };
  /** The account the sister app published when it answered (`approverUserId`, `approverEmail`). */
  approver?: { approverUserId: string; approverEmail: string };
}): Harness => {
  const states: SiblingSignInState[] = [];
  const polls = [...(opts.polls ?? [{ status: "pending" }, APPROVED])];
  const client = {
    start: vi.fn(async () => {
      if (opts.startError) throw opts.startError;
      return { requestId: "r1", shortCode: "ABCD-EFGH", qrPayload: "q", expiresAt: "2099-01-01T00:00:00Z", deviceName: "OnePlus 9" };
    }),
    poll: vi.fn(async () => polls.shift() ?? { status: "pending" }),
    cancel: vi.fn(),
    deliverLocalKey: vi.fn(() => opts.deliver ?? true),
  };
  const approved: SiblingApprovalAnswer = { result: "approved", sealedKey: JSON.stringify(SEALED), ...(opts.approver ?? APPROVER) };
  const approve = vi.fn(async (): Promise<SiblingApprovalAnswer> => opts.answer ?? approved);
  const complete = vi.fn(async () => opts.completion ?? { ok: true });
  let timeoutResolve: (() => void) | null = null;
  const controller = createSiblingSignInController({
    client: client as unknown as PairingClientCore,
    approve,
    complete: complete as never,
    onState: (state) => {
      console.info(SUITE, "state", state);
      states.push(state);
    },
    now: () => 0,
    sleep: (ms, signal) => {
      if (ms !== SIBLING_SIGN_IN_TIMEOUT_MS) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      timeoutResolve = resolve;
      signal.addEventListener("abort", () => resolve());
      return promise;
    },
    logTag: "test.sibling",
  });
  return {
    states,
    client: client as never,
    approve,
    complete,
    fireTimeout: () => timeoutResolve?.(),
    start: controller.start,
    cancel: controller.cancel,
    stop: controller.stop,
    // Every step of the controller is a promise: draining the microtask queue settles it, no clock involved.
    settled: async () => {
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
    },
  };
};

describe("sibling sign-in controller", () => {
  it("hands the code to the sister app, delivers the sealed key, polls and completes", async () => {
    const h = harness({});
    h.start();
    await h.settled();
    expect(h.approve).toHaveBeenCalledWith({ requestId: "r1", shortCode: "ABCD-EFGH" });
    expect(h.client.deliverLocalKey).toHaveBeenCalledWith("r1", SEALED);
    expect(h.client.poll).toHaveBeenCalledTimes(2);
    expect(h.complete).toHaveBeenCalledWith(APPROVED);
    expect(h.states.map((s) => s.phase)).toEqual(["waiting", "completing", "done"]);
    expect(h.client.cancel).not.toHaveBeenCalled();
  });

  it("goes back to the offer when the user cancels in the sister app", async () => {
    const h = harness({ answer: { result: "cancelled" } });
    h.start();
    await h.settled();
    expect(h.client.poll).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.client.cancel).toHaveBeenCalled();
    expect(h.states.map((s) => s.phase)).toEqual(["waiting", "idle"]);
  });

  it("fails and forgets the request when the sister app cannot be reached", async () => {
    const h = harness({ answer: { result: "error", message: "sister_unreachable" } });
    h.start();
    await h.settled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "sister_unreachable" });
    expect(h.client.cancel).toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("fails after two minutes without an answer from the sister app", async () => {
    const h = harness({ answer: Promise.withResolvers<SiblingApprovalAnswer>().promise });
    h.start();
    await h.settled();
    expect(h.states.map((s) => s.phase)).toEqual(["waiting"]);
    h.fireTimeout();
    await h.settled();
    console.info(SUITE, "timeout states", h.states);
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "timeout" });
    expect(h.client.cancel).toHaveBeenCalled();
    expect(SIBLING_SIGN_IN_TIMEOUT_MS).toBe(120_000);
  });

  it("fails when the sealed key is not this request's", async () => {
    const h = harness({ deliver: false });
    h.start();
    await h.settled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "key_unreadable" });
    expect(h.client.poll).not.toHaveBeenCalled();
  });

  it("fails on a sealed key that is not JSON", async () => {
    const h = harness({ answer: { result: "approved", sealedKey: "not json", ...APPROVER } });
    h.start();
    await h.settled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "key_unreadable" });
    expect(h.client.deliverLocalKey).not.toHaveBeenCalled();
  });

  it("fails when the pairing request cannot be opened", async () => {
    const h = harness({ startError: new TypeError("Network request failed") });
    h.start();
    await h.settled();
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "start_failed" });
  });

  it("fails when the completion refuses the key", async () => {
    const h = harness({ completion: { ok: false, reason: "key_mismatch" } });
    h.start();
    await h.settled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "key_mismatch" });
  });

  it("fails when the request expires before the API approves it", async () => {
    const h = harness({ polls: [{ status: "expired" }] });
    h.start();
    await h.settled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "expired" });
  });

  it("Cancel in the asking app returns to the offer and ignores a late answer", async () => {
    const { promise, resolve: answer } = Promise.withResolvers<SiblingApprovalAnswer>();
    const h = harness({ answer: promise });
    h.start();
    await h.settled();
    h.cancel();
    answer({ result: "approved", sealedKey: JSON.stringify(SEALED), ...APPROVER });
    await h.settled();
    expect(h.states.map((s) => s.phase)).toEqual(["waiting", "idle"]);
    expect(h.client.deliverLocalKey).not.toHaveBeenCalled();
    expect(h.client.cancel).toHaveBeenCalled();
  });

  it("refuses an approval for another account than the one the sister app was signed in to when it answered", async () => {
    // A code that leaked could be approved by someone else's account: the sign-in must be the sister's own account.
    const h = harness({ approver: { approverUserId: "u2", approverEmail: "grace@example.com" } });
    h.start();
    await h.settled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ phase: "failed", reason: "wrong_account" });
    expect(h.client.cancel).toHaveBeenCalled();
  });

  it("matches the account's email case-insensitively", async () => {
    const h = harness({ approver: { approverUserId: "u1", approverEmail: " Ada@Example.com" } });
    h.start();
    await h.settled();
    expect(h.complete).toHaveBeenCalledWith(APPROVED);
    expect(h.states.at(-1)).toEqual({ phase: "done" });
  });
});
