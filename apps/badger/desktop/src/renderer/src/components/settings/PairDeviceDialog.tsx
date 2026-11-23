import { useTranslation } from "react-i18next";
import { isClientUiLanguage } from "@space/shared";
import { approvePairing, connectPairing, denyPairing, lookupPairing, readPairingReveal } from "@space/shared/api";
import { PairDeviceDialog as SharedPairDeviceDialog, type PairDeviceActions } from "@space/desktop-shell/components";
import {
  ApprovePairingError,
  approvePairingRequest,
  approvePairingResult,
  denyPairingRequest,
  keyOpensProbe,
  lookupPairingRequest,
  runPairingCheck,
  type ApprovePairingDeps,
  type CheckedPairingRequest,
  type PairingRequestView,
} from "@space/pairing-crypto";
import { getLibraryMeta } from "@/api";
import { decryptBase64ToBytes } from "@/lib/crypto";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { useHasPassword } from "@/auth";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "pairing-approve" });

export const pairDeviceDeps: ApprovePairingDeps = {
  lookup: lookupPairing,
  approve: (token, requestId, sealedKey, password, twoFactorCode) =>
    approvePairing(token, requestId, sealedKey, undefined, password, twoFactorCode),
  deny: denyPairing,
  getLibraryKey: getStoredLibraryKey,
  // PRIV-PAIR-02: a key the account no longer opens (rotated elsewhere) is not sent.
  keyOpensAccount: (token, libraryKey) =>
    keyOpensProbe(libraryKey, async () => (await getLibraryMeta(token)).keyProbe, decryptBase64ToBytes),
  connect: connectPairing,
  readReveal: readPairingReveal,
  now: () => Date.now(),
  log: (message, extra) => log.info(extra ?? {}, message),
};

/** A checked request as the dialog shows it: an older API that sends no `purpose` asks to sign in. */
type BadgerPairingRequest = CheckedPairingRequest & Pick<PairingRequestView, "purpose">;

/** Badger runs the shared approver core in the window, where its session token and library key already live. */
const badgerActions = (deps: ApprovePairingDeps, token: string | null): PairDeviceActions<BadgerPairingRequest> => {
  const signedIn = () => {
    if (!token) throw new ApprovePairingError("signed_out");
    return token;
  };
  return {
    lookup: (code) =>
      approvePairingResult(async () => {
        const request = await lookupPairingRequest(deps, signedIn(), code);
        // PRIV-PAIR-01: the code was typed, so the user compares the check code on both screens.
        const checked = await runPairingCheck(deps, signedIn(), request);
        return { ...checked, purpose: request.purpose === "key" ? "key" : "sign_in" };
      }),
    approve: (request, proof) => approvePairingResult(() => approvePairingRequest(deps, signedIn(), request, proof)),
    deny: (request) => approvePairingResult(() => denyPairingRequest(deps, signedIn(), request)),
  };
};

/**
 * ACCT-PAIR-01 / ACCT-PAIR-02 / ACCT-PAIR-05: approve another device (a TV, a phone, another computer) of Badger or
 * Parrot from Badger's settings; the question names the asking app. The dialog itself is shared with Parrot desktop
 * (`@space/desktop-shell/components`).
 */
export default function PairDeviceDialog({
  open,
  onOpenChange,
  token,
  deps = pairDeviceDeps,
  onApproved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string | null;
  deps?: ApprovePairingDeps;
  onApproved?: () => void;
}) {
  const { i18n } = useTranslation();
  // ACCT-AUTH-04 / ACCT-PAIR-02: an account without a password approves with a code instead.
  const hasPassword = useHasPassword();
  return (
    <SharedPairDeviceDialog
      open={open}
      onOpenChange={onOpenChange}
      actions={badgerActions(deps, token)}
      language={isClientUiLanguage(i18n.language) ? i18n.language : "en"}
      onApproved={onApproved}
      hasPassword={hasPassword}
    />
  );
}
