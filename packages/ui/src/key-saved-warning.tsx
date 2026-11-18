import type { KeySavedWarningText } from "@space/shared/keySavedWarning";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

/**
 * ACCT-DEV-04, shared by the desktop apps that make a new library key: pressing "I've saved my key" opens this warning
 * instead of moving on. "Yes, I understand" is the only way forward; "Go back" (focused first) and closing the window
 * both return to the key screen, with the key still shown.
 */
export function KeySavedWarningDialog({
  open,
  text,
  onConfirm,
  onBack,
}: {
  open: boolean;
  text: KeySavedWarningText;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onBack();
      }}
    >
      <DialogContent data-testid="key-saved-warning">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription asChild>
            <ul className="list-disc space-y-2 pl-5 text-left">
              <li>{text.needed}</li>
              <li>{text.noReset}</li>
              <li className="font-medium text-foreground">{text.lost}</li>
            </ul>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="secondary" autoFocus onClick={onBack} data-testid="key-saved-warning-back">
            {text.back}
          </Button>
          <Button type="button" onClick={onConfirm} data-testid="key-saved-warning-confirm">
            {text.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
