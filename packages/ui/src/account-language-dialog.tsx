import { accountLanguageNativeName, accountLanguagePrompt } from "@space/shared/accountLanguage";
import type { AccountLanguage } from "@space/shared/i18n";

import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { Flag } from "./flag";

/** The two languages "Which language do you want?" offers: this device's and the account's. */
export type AccountLanguageQuestion = { device: AccountLanguage; account: AccountLanguage };

/**
 * "Which language do you want?" right after a sign-in, sign-up or pairing whose account speaks another language than
 * this device (UX-I18N-07), the same on every app: the shared texts (`accountLanguagePrompt`) in `shown` (default: the
 * device's language, the one the user picked before signing in) and one button per language, each by its flag and its
 * own name (UX-I18N-10).
 * Closed while `question` is `null`. Closing it calls `onDismiss`, which by default keeps the account's language.
 */
export const AccountLanguageDialog = ({
  question,
  shown,
  onPick,
  onDismiss,
  closeLabel,
}: {
  question: AccountLanguageQuestion | null;
  shown?: string;
  onPick: (language: AccountLanguage) => void;
  onDismiss?: () => void;
  closeLabel?: string;
}) => {
  if (!question) return null;
  const texts = accountLanguagePrompt(shown ?? question.device, question);
  const dismiss = onDismiss ?? (() => onPick(question.account));
  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-w-md" closeLabel={closeLabel} data-testid="account-language-dialog">
        <DialogHeader>
          <DialogTitle>{texts.title}</DialogTitle>
          <DialogDescription>{texts.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" className="gap-2" data-testid="account-language-account" onClick={() => onPick(question.account)}>
            <Flag code={question.account} />
            {accountLanguageNativeName(question.account)}
          </Button>
          <Button type="button" className="gap-2" data-testid="account-language-device" onClick={() => onPick(question.device)}>
            <Flag code={question.device} />
            {accountLanguageNativeName(question.device)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
