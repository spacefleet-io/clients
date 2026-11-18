import { useCallback, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

/** The question's words, in the app's own term for the key. `showKey` only where the app can show the key. */
export type SignOutKeyCheckText = { title: string; body: string; cancel: string; confirm: string; showKey?: string };

export type SignOutKeyCheckEvent = "asked" | "signedOutAtOnce" | "cancelled" | "showKey" | "confirmed";

export type SignOutWithKeyCheck = {
  /** The user's own Sign out of this device: asks first when this device holds the library key. */
  requestSignOut: () => Promise<void>;
  /** The question; render it once wherever the hook is used. */
  dialog: ReactNode;
};

/**
 * ACCT-DEV-03, shared by Badger and Parrot desktop and their web players: the user's own Sign out forgets the library
 * key on this device, and without the saved key the only way back in is typing it (QR-code sign-in needs another
 * device that still holds it). When `holdsKey` says this device holds the key, Sign out first asks whether the key was
 * saved: Cancel (focused by default) changes nothing, the optional "Show my key" hands over to `onShowKey`, and only
 * the destructive confirm signs out. Without a key it signs out at once.
 */
export function useSignOutWithKeyCheck(input: {
  holdsKey: () => boolean | Promise<boolean>;
  signOut: () => Promise<void>;
  text: SignOutKeyCheckText;
  onShowKey?: () => void;
  log?: (event: SignOutKeyCheckEvent) => void;
}): SignOutWithKeyCheck {
  const { holdsKey, signOut, text, onShowKey, log } = input;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const requestSignOut = useCallback(async () => {
    if (!(await holdsKey())) {
      log?.("signedOutAtOnce");
      await signOut();
      return;
    }
    log?.("asked");
    setOpen(true);
  }, [holdsKey, signOut, log]);

  const cancel = () => {
    log?.("cancelled");
    setOpen(false);
  };

  const showKey = () => {
    log?.("showKey");
    setOpen(false);
    onShowKey?.();
  };

  const confirm = async () => {
    log?.("confirmed");
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) cancel();
      }}
    >
      <DialogContent data-testid="sign-out-key-check">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="secondary" autoFocus disabled={busy} onClick={cancel}>
            {text.cancel}
          </Button>
          {onShowKey && text.showKey ? (
            <Button type="button" variant="outline" disabled={busy} onClick={showKey}>
              {text.showKey}
            </Button>
          ) : null}
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {text.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { requestSignOut, dialog };
}
