import { PairDeviceDialog, type PairDeviceActions } from "@space/desktop-shell/components";
import type { PairingRequestView } from "@space/pairing-crypto";
import type { ParrotBridge, ParrotLanguage } from "../../shared/ipc";

/**
 * The dialog's three steps go over IPC: main runs the shared approver (`src/main/pairingApprove.ts`) with the session
 * token and the library key, which never reach this window. Only the request's view and an error kind come back.
 */
export const parrotPairDeviceActions = (
  bridge: Pick<ParrotBridge, "lookupPairing" | "approvePairing" | "denyPairing">,
): PairDeviceActions<PairingRequestView> => ({
  lookup: (code) => bridge.lookupPairing(code),
  approve: (request, proof) => bridge.approvePairing(request.requestId, proof),
  deny: (request) => bridge.denyPairing(request.requestId),
});

/**
 * ACCT-PAIR-01 / ACCT-PAIR-02: approve another device (a browser on the Parrot web player, a phone, another computer)
 * from Parrot desktop. The dialog and its text are the ones Badger desktop shows (`@space/desktop-shell/components`).
 */
export default function PairDevice({ language, onClose }: { language: ParrotLanguage; onClose: () => void }) {
  return (
    <PairDeviceDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={parrotPairDeviceActions(window.parrot)}
      language={language}
    />
  );
}
