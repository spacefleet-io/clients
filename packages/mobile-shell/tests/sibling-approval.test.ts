/**
 * @test-id MOBILE-SHELL-SIBLING-APPROVAL-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile,parrot]
 * @why The signed-in app answers its sister's "Let {App} use your SpaceFleet account?". Allow must approve only the
 *   sister app's own phone sign-in and hand the sealed key back over the local channel (never to the API); Cancel must
 *   refuse the request so the sister stops waiting; any failure must still answer, so the sister app never hangs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealedKey, SiblingApproveDeps } from "@space/pairing-crypto";

const SUITE = "[sibling-approval]";
const SEALED: SealedKey = { v: 1, epk: "epk", iv: "iv", ct: "ct" };

const approveSiblingRequest = vi.fn();
const refuseSiblingRequest = vi.fn();
vi.mock("@space/pairing-crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/pairing-crypto")>()),
  approveSiblingRequest: (...args: unknown[]) => approveSiblingRequest(...args),
  refuseSiblingRequest: (...args: unknown[]) => refuseSiblingRequest(...args),
}));

import { ApprovePairingError } from "@space/pairing-crypto";
import { answerIncomingSiblingApproval } from "../src/sibling/approval";

const DEPS = { lookup: vi.fn(), approveLocal: vi.fn(), deny: vi.fn(), getLibraryKey: vi.fn(), now: () => 0 } as unknown as SiblingApproveDeps;
const INCOMING = { requestId: "r1", shortCode: "ABCD-EFGH", callerApp: "parrot" };

const answer = async (allow: boolean, token: string | null = "badger-token") => {
  const finish = vi.fn(async () => undefined);
  const result = await answerIncomingSiblingApproval({ self: "badger", token, deps: DEPS, incoming: INCOMING, finish }, allow);
  console.info(SUITE, { allow, result, finish: finish.mock.calls });
  return { result, finish };
};

describe("answering the sister app's sign-in", () => {
  beforeEach(() => {
    approveSiblingRequest.mockReset();
    refuseSiblingRequest.mockReset();
  });

  it("Allow approves the sister's phone sign-in and hands the sealed key back", async () => {
    approveSiblingRequest.mockResolvedValue({ sessionId: "s1", sealedKey: SEALED });
    const { finish } = await answer(true);
    expect(approveSiblingRequest).toHaveBeenCalledWith(DEPS, "badger-token", "ABCD-EFGH", { asker: "parrot", deviceType: "mobile" });
    expect(finish).toHaveBeenCalledWith({ result: "approved", sealedKey: JSON.stringify(SEALED) });
  });

  it("Allow that the core refuses answers an error with its kind", async () => {
    approveSiblingRequest.mockRejectedValue(new ApprovePairingError("bad_request"));
    const { finish } = await answer(true);
    expect(finish).toHaveBeenCalledWith({ result: "error", message: "bad_request" });
  });

  it("answers an error without asking the API when this app is signed out", async () => {
    const { finish } = await answer(true, null);
    expect(approveSiblingRequest).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({ result: "error", message: "not_signed_in" });
  });

  it("Cancel refuses the request and answers cancelled", async () => {
    refuseSiblingRequest.mockResolvedValue(undefined);
    const { finish } = await answer(false);
    expect(refuseSiblingRequest).toHaveBeenCalledWith(DEPS, "badger-token", "ABCD-EFGH", { asker: "parrot", deviceType: "mobile" });
    expect(finish).toHaveBeenCalledWith({ result: "cancelled" });
  });

  it("Cancel still answers cancelled when the refusal cannot reach the API", async () => {
    refuseSiblingRequest.mockRejectedValue(new TypeError("Network request failed"));
    const { finish } = await answer(false);
    expect(finish).toHaveBeenCalledWith({ result: "cancelled" });
  });
});
