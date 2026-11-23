// The real side effects of the sf-pair-v2 check (PRIV-PAIR-01, PRIV-PAIR-02) for the phone and TV approvers of Badger
// and Parrot. Its own entry point: it pulls in native crypto (`../libraryEnvelope`), which the pure flow must not.
import { keyOpensProbe } from "@space/pairing-crypto";
import { connectPairing, getLibraryMeta, readPairingReveal } from "@space/shared/api";
import type { SpaceAppId } from "@space/shared/appScope";
import { decryptBase64ToBytes } from "../libraryEnvelope";
import type { PairingDeps } from "./pairingFlow";

/** `keyOpensAccount` reads `app`'s key probe; the account's probe is the same for every app's library meta. */
export const pairingCheckDeps = (app: SpaceAppId): Pick<PairingDeps, "keyOpensAccount" | "connect" | "readReveal"> => ({
  keyOpensAccount: (token, libraryKey) =>
    keyOpensProbe(libraryKey, async () => (await getLibraryMeta(token, app)).keyProbe, decryptBase64ToBytes),
  connect: connectPairing,
  readReveal: readPairingReveal,
});
