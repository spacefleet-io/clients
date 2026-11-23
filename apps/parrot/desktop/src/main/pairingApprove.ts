/**
 * ACCT-PAIR-01 / ACCT-PAIR-02 / PRIV-KEY-05 / PRIV-PAIR-01: Parrot desktop approves another device (a browser on the
 * Parrot web player, a phone, a computer) with the shared approver core (`@space/pairing-crypto`), run here in main: the
 * session token and the library key never leave main. The window only gets the device's name and type, its expiry, the
 * request id, the check code to compare and, on failure, an error kind. The new device's public key and the check stay
 * here, keyed by the request id, so the key is sealed only for a request this window looked up and checked.
 */
import {
  ApprovePairingError,
  approvePairingRequest,
  approvePairingResult,
  denyPairingRequest,
  lookupPairingRequest,
  pairingRequestView,
  runPairingCheck,
  type ApprovePairingDeps,
  type ApprovePairingProof,
  type ApprovePairingResult,
  type CheckedPairingRequest,
  type PairingRequestView,
} from "@space/pairing-crypto";

export type ParrotPairingApprover = {
  lookup(code: string): Promise<ApprovePairingResult<PairingRequestView>>;
  /** `proof` as it came over IPC: the account password, or `{ code }` for an account without one (ACCT-AUTH-04). */
  approve(requestId: string, proof: unknown): Promise<ApprovePairingResult<{ sessionId: string | null }>>;
  deny(requestId: string): Promise<ApprovePairingResult<null>>;
};

/** The proof as it came over IPC: a password string, `{ code }`, or anything else read as an empty password. */
const proofFromIpc = (proof: unknown): ApprovePairingProof => {
  if (typeof proof === "string") return proof;
  if (proof && typeof proof === "object" && "code" in proof && typeof proof.code === "string") return { code: proof.code };
  return "";
};

export const createParrotPairingApprover = (options: {
  token: () => string | null;
  libraryKey: () => string | null;
  api: Pick<ApprovePairingDeps, "lookup" | "approve" | "deny" | "connect" | "readReveal" | "keyOpensAccount">;
  now?: () => number;
  log: (line: string) => void;
}): ParrotPairingApprover => {
  const deps: ApprovePairingDeps = {
    ...options.api,
    getLibraryKey: async () => options.libraryKey(),
    now: options.now ?? (() => Date.now()),
    log: (message, extra) => options.log(`[pairing] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`),
  };
  /** Requests this window looked up and checked, by id: the public key the library key may be sealed to. */
  const looked = new Map<string, CheckedPairingRequest>();

  const token = () => {
    const value = options.token();
    if (!value) throw new ApprovePairingError("signed_out");
    return value;
  };
  const known = (requestId: unknown) => {
    const request = typeof requestId === "string" ? looked.get(requestId) : undefined;
    if (!request) throw new ApprovePairingError("not_found");
    return request;
  };
  const logged = <T>(step: string, result: ApprovePairingResult<T>) => {
    options.log(`[pairing] ${step}: ${result.ok ? "ok" : result.kind}`);
    return result;
  };

  return {
    lookup: async (code) =>
      logged(
        "lookup",
        await approvePairingResult(async () => {
          const request = await lookupPairingRequest(deps, token(), String(code ?? ""));
          // PRIV-PAIR-01: typed code, so the window shows the check code to compare.
          const checked = await runPairingCheck(deps, token(), request);
          looked.set(checked.requestId, checked);
          return pairingRequestView(checked);
        }),
      ),
    approve: async (requestId, proof) =>
      logged(
        "approve",
        await approvePairingResult(async () => {
          const request = known(requestId);
          const result = await approvePairingRequest(deps, token(), request, proofFromIpc(proof));
          looked.delete(request.requestId);
          return result;
        }),
      ),
    deny: async (requestId) =>
      logged(
        "deny",
        await approvePairingResult(async () => {
          const request = known(requestId);
          looked.delete(request.requestId);
          await denyPairingRequest(deps, token(), request);
          return null;
        }),
      ),
  };
};
