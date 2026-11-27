import { useTranslation } from "react-i18next";
import { Button, Checkbox, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@space/ui";
import { Copy } from "lucide-react";
import { LibraryKeyWordsGrid } from "@space/ui/library-key-words";
import type { NewLibraryKey } from "@space/shared/libraryKeyWords";
import { formatKeyForDisplay } from "@/lib/storage";
import type { ShownLibraryKey } from "@/lib/settings/useLibraryRecoveryFlows";
import ReauthPasswordField from "@/components/ReauthPasswordField";
import { useHasPassword } from "@/auth";

type RecoveryDialogsProps = {
  showKeyOpen: boolean;
  setShowKeyOpen: (open: boolean) => void;
  showKeyValue: ShownLibraryKey | null;
  copyShowKey: () => void;
  showKeyPassword: string;
  setShowKeyPassword: (value: string) => void;
  showKeyNeedsCode: boolean;
  showKeyCode: string;
  setShowKeyCode: (value: string) => void;
  showKeyMethod: "email" | "totp" | null;
  showKeyNotice: string | null;
  showKeyError: string | null;
  showKeyBusy: boolean;
  submitShowKey: () => void | Promise<void>;
  recoveryOpen: boolean;
  setRecoveryOpen: (open: boolean) => void;
  recoveryKey: NewLibraryKey | null;
  copyRecoveryKey: () => void;
  recoveryConfirmed: boolean;
  setRecoveryConfirmed: (value: boolean) => void;
  recoveryPassword: string;
  setRecoveryPassword: (value: string) => void;
  recoveryNeedsCode: boolean;
  recoveryCode: string;
  setRecoveryCode: (value: string) => void;
  recoveryMethod: "email" | "totp" | null;
  recoveryNotice: string | null;
  recoveryError: string | null;
  recoveryBusy: boolean;
  submitRecovery: () => void | Promise<void>;
  resetOpen: boolean;
  setResetOpen: (open: boolean) => void;
  resetConfirmed: boolean;
  setResetConfirmed: (value: boolean) => void;
  resetPassword: string;
  setResetPassword: (value: string) => void;
  resetNeedsCode: boolean;
  resetCode: string;
  setResetCode: (value: string) => void;
  resetMethod: "email" | "totp" | null;
  resetNotice: string | null;
  resetError: string | null;
  resetBusy: boolean;
  submitReset: () => void | Promise<void>;
  resetResending: boolean;
  resendResetCode: () => void | Promise<void>;
};

export default function SettingsRecoveryDialogs({
  showKeyOpen,
  setShowKeyOpen,
  showKeyValue,
  copyShowKey,
  showKeyPassword,
  setShowKeyPassword,
  showKeyNeedsCode,
  showKeyCode,
  setShowKeyCode,
  showKeyMethod,
  showKeyNotice,
  showKeyError,
  showKeyBusy,
  submitShowKey,
  recoveryOpen,
  setRecoveryOpen,
  recoveryKey,
  copyRecoveryKey,
  recoveryConfirmed,
  setRecoveryConfirmed,
  recoveryPassword,
  setRecoveryPassword,
  recoveryNeedsCode,
  recoveryCode,
  setRecoveryCode,
  recoveryMethod,
  recoveryNotice,
  recoveryError,
  recoveryBusy,
  submitRecovery,
  resetOpen,
  setResetOpen,
  resetConfirmed,
  setResetConfirmed,
  resetPassword,
  setResetPassword,
  resetNeedsCode,
  resetCode,
  setResetCode,
  resetMethod,
  resetNotice,
  resetError,
  resetBusy,
  submitReset,
  resetResending,
  resendResetCode,
}: RecoveryDialogsProps) {
  const { t } = useTranslation();
  // ACCT-AUTH-04: an account without a password confirms each of these with a code alone.
  const hasPassword = useHasPassword();

  return (
    <>
      <Dialog open={showKeyOpen} onOpenChange={setShowKeyOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.recovery.show.dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">{t("settings.recovery.show.keyLabel")}</div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={copyShowKey}
                  disabled={!showKeyValue}
                  aria-label={t("settings.recovery.rotate.copyButton")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {showKeyValue?.words ? (
                <LibraryKeyWordsGrid words={showKeyValue.words} className="rounded-md border border-border p-3" />
              ) : (
                <Input
                  readOnly
                  value={showKeyValue ? formatKeyForDisplay(showKeyValue.key) : "•••• •••• •••• ••••"}
                  className="font-mono text-xs"
                />
              )}
              {showKeyValue && !showKeyValue.words ? (
                <div className="text-xs text-muted-foreground" data-testid="show-key-paired">
                  {t("libraryKeyWords.pairedNoWords")}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3">
              <ReauthPasswordField
                id="showKeyPassword"
                label={t("settings.recovery.show.passwordLabel")}
                value={showKeyPassword}
                onChange={setShowKeyPassword}
              />
              {showKeyNeedsCode ? (
                <div className="grid gap-2">
                  <Label htmlFor="showKeyCode">{t("settings.recovery.show.codeLabel")}</Label>
                  <Input
                    id="showKeyCode"
                    value={showKeyCode}
                    onChange={(e) => setShowKeyCode(e.target.value)}
                    autoComplete="one-time-code"
                  />
                  <div className="text-xs text-muted-foreground">
                    {showKeyMethod === "totp"
                      ? t("settings.recovery.show.codeHintTotp")
                      : t("settings.recovery.show.codeHintEmail")}
                  </div>
                </div>
              ) : null}
            </div>

            {showKeyNotice ? (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                {showKeyNotice}
              </div>
            ) : null}
            {showKeyError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {showKeyError}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowKeyOpen(false)}>
              {t("settings.recovery.show.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void submitShowKey()}
              disabled={(hasPassword && !showKeyPassword.trim()) || showKeyBusy}
            >
              {showKeyBusy ? t("settings.recovery.show.working") : t("settings.recovery.show.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.recovery.rotate.dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">{t("settings.recovery.rotate.keyLabel")}</div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={copyRecoveryKey}
                  disabled={!recoveryKey}
                  aria-label={t("settings.recovery.rotate.copyButton")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {recoveryKey ? (
                <LibraryKeyWordsGrid words={recoveryKey.words} className="rounded-md border border-border p-3" />
              ) : null}
              <div className="text-xs text-muted-foreground">{t("settings.recovery.rotate.keyHint")}</div>
            </div>

            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
              <Checkbox checked={recoveryConfirmed} onCheckedChange={(checked) => setRecoveryConfirmed(Boolean(checked))} />
              <span>{t("settings.recovery.rotate.confirmLabel")}</span>
            </label>

            <div className="grid gap-3">
              <ReauthPasswordField
                id="recoveryPassword"
                label={t("settings.recovery.rotate.passwordLabel")}
                value={recoveryPassword}
                onChange={setRecoveryPassword}
              />
              {recoveryNeedsCode ? (
                <div className="grid gap-2">
                  <Label htmlFor="recoveryCode">{t("settings.recovery.rotate.codeLabel")}</Label>
                  <Input
                    id="recoveryCode"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                  <div className="text-xs text-muted-foreground">
                    {recoveryMethod === "totp"
                      ? t("settings.recovery.rotate.codeHintTotp")
                      : t("settings.recovery.rotate.codeHintEmail")}
                  </div>
                </div>
              ) : null}
            </div>

            {recoveryNotice ? (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
                {recoveryNotice}
              </div>
            ) : null}
            {recoveryError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {recoveryError}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setRecoveryOpen(false)}>
              {t("settings.recovery.rotate.cancel")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void submitRecovery()}
              disabled={!recoveryConfirmed || (hasPassword && !recoveryPassword.trim()) || recoveryBusy}
            >
              {recoveryBusy ? t("settings.recovery.rotate.working") : t("settings.recovery.rotate.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.recovery.reset.dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              {t("settings.recovery.reset.warning")}
            </div>

            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
              <Checkbox checked={resetConfirmed} onCheckedChange={(checked) => setResetConfirmed(Boolean(checked))} />
              <span>{t("settings.recovery.reset.confirmLabel")}</span>
            </label>

            <div className="grid gap-3">
              <ReauthPasswordField
                id="resetPassword"
                label={t("settings.recovery.reset.passwordLabel")}
                value={resetPassword}
                onChange={setResetPassword}
              />
              {resetNeedsCode ? (
                <div className="grid gap-2">
                  <Label htmlFor="resetCode">{t("settings.recovery.reset.codeLabel")}</Label>
                  <Input
                    id="resetCode"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                  <div className="text-xs text-muted-foreground">
                    {resetMethod === "totp"
                      ? t("settings.recovery.reset.codeHintTotp")
                      : t("settings.recovery.reset.codeHintEmail")}
                  </div>
                  {resetMethod === "email" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => void resendResetCode()}
                      disabled={resetResending}
                    >
                      {resetResending ? t("settings.recovery.reset.resending") : t("settings.recovery.reset.resend")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {resetNotice ? (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
                {resetNotice}
              </div>
            ) : null}
            {resetError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {resetError}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setResetOpen(false)}>
              {t("settings.recovery.reset.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void submitReset()}
              disabled={!resetConfirmed || (hasPassword && !resetPassword.trim()) || resetBusy}
            >
              {resetBusy ? t("settings.recovery.reset.working") : t("settings.recovery.reset.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
