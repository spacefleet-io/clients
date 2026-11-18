import { useTranslation } from "react-i18next";
import ReauthPasswordField from "@/components/ReauthPasswordField";
import { useHasPassword } from "@/auth";
import type { TwoFactorMethod } from "@/api";
import { Button } from "@space/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@space/ui";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { RadioGroup, RadioGroupItem } from "@space/ui";

type AccountTwoFactorSectionProps = {
  twoFactorEnabled: boolean;
  twoFactorMethod: TwoFactorMethod | null;
  twoFactorBusy: boolean;
  twoFactorMessage: string | null;
  twoFactorError: string | null;
  enableFlowOpen: boolean;
  enableMethod: TwoFactorMethod | "";
  setEnableMethod: (value: TwoFactorMethod) => void;
  emailEnableRequested: boolean;
  emailEnableCode: string;
  setEmailEnableCode: (value: string) => void;
  totpSetupState: {
    secret: string;
    otpauthUrl: string;
    qrCode: string;
  } | null;
  totpCode: string;
  setTotpCode: (value: string) => void;
  disableFlowOpen: boolean;
  /** ACCT-AUTH-04: turning the second step on, replacing it or turning it off asks for the password again. */
  reauthPassword: string;
  setReauthPassword: (value: string) => void;
  /** The current second-step code, asked with the password while 2FA is on. */
  reauthCode: string;
  setReauthCode: (value: string) => void;
  /** The API asked for the code (an email code was just sent, or the code was wrong). */
  reauthCodeAsked: boolean;
  resetTwoFactorFlows: () => void;
  startEnable: () => void;
  requestEmailEnable: () => void;
  confirmEmailEnable: () => void;
  generateTotpSetup: () => void;
  confirmTotpEnable: () => void;
  copyText: (value: string) => void;
  startDisable: () => void;
  confirmDisable: () => void;
};

export default function AccountTwoFactorSection({
  twoFactorEnabled,
  twoFactorMethod,
  twoFactorBusy,
  twoFactorMessage,
  twoFactorError,
  enableFlowOpen,
  enableMethod,
  setEnableMethod,
  emailEnableRequested,
  emailEnableCode,
  setEmailEnableCode,
  totpSetupState,
  totpCode,
  setTotpCode,
  disableFlowOpen,
  reauthPassword,
  setReauthPassword,
  reauthCode,
  setReauthCode,
  reauthCodeAsked,
  resetTwoFactorFlows,
  startEnable,
  requestEmailEnable,
  confirmEmailEnable,
  generateTotpSetup,
  confirmTotpEnable,
  copyText,
  startDisable,
  confirmDisable,
}: AccountTwoFactorSectionProps) {
  const { t } = useTranslation();
  // ACCT-AUTH-04: an account without a password is asked the code alone (the first try emails it unless the
  // authenticator app is on).
  const hasPassword = useHasPassword();
  // With an authenticator on, its code is always needed; an email code is asked once the API has sent it.
  const reauthCodeShown = reauthCodeAsked || (twoFactorEnabled && twoFactorMethod === "totp");
  const reauthReady = (!hasPassword || reauthPassword.length > 0) && (!reauthCodeShown || reauthCode.trim().length > 0);

  const reauthFields = (
    <div className="grid gap-3 max-w-xs">
      <ReauthPasswordField
        id="twoFactorPassword"
        label={t("account.twoFactor.passwordLabel")}
        value={reauthPassword}
        onChange={setReauthPassword}
        disabled={twoFactorBusy}
      />
      {reauthCodeShown ? (
        <div className="grid gap-2">
          <Label htmlFor="twoFactorReauthCode">{t("account.twoFactor.currentCode")}</Label>
          <Input
            id="twoFactorReauthCode"
            value={reauthCode}
            onChange={(event) => setReauthCode(event.target.value)}
            placeholder={t("account.twoFactor.codePlaceholder")}
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={twoFactorBusy}
          />
        </div>
      ) : null}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account.twoFactor.title")}</CardTitle>
        <CardDescription>
          {twoFactorEnabled
            ? !twoFactorMethod
              ? t("account.twoFactor.status.enabledNeedsSetup")
              : twoFactorMethod === "totp"
                ? t("account.twoFactor.status.enabledTotp")
                : t("account.twoFactor.status.enabledEmail")
            : t("account.twoFactor.status.disabled")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {twoFactorMessage ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">{twoFactorMessage}</div>
        ) : null}
        {twoFactorError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {twoFactorError}
          </div>
        ) : null}

        {!twoFactorEnabled || !twoFactorMethod ? (
          <>
            {!enableFlowOpen && !(twoFactorEnabled && !twoFactorMethod) ? (
              <Button type="button" onClick={startEnable}>
                {twoFactorEnabled ? t("account.twoFactor.setup") : t("account.twoFactor.activate")}
              </Button>
            ) : (
              <div className="space-y-4 rounded-xl border border-border bg-muted/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-semibold">{t("account.twoFactor.chooseMethod")}</div>
                    <div className="text-sm text-muted-foreground">{t("account.twoFactor.chooseMethodSubtitle")}</div>
                  </div>
                  <Button type="button" variant="ghost" onClick={resetTwoFactorFlows} disabled={twoFactorBusy}>
                    {t("account.common.startOver")}
                  </Button>
                </div>
                <RadioGroup value={enableMethod} onValueChange={(v) => setEnableMethod(v as TwoFactorMethod)}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="email" id="m-email" />
                    <Label htmlFor="m-email">{t("account.twoFactor.methodEmail")}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="totp" id="m-totp" />
                    <Label htmlFor="m-totp">{t("account.twoFactor.methodTotp")}</Label>
                  </div>
                </RadioGroup>

                {enableMethod ? reauthFields : null}

                {enableMethod === "email" ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" onClick={requestEmailEnable} disabled={!reauthReady || twoFactorBusy}>
                        {emailEnableRequested ? t("account.twoFactor.resendCode") : t("account.twoFactor.sendCode")}
                      </Button>
                      <div className="text-sm text-muted-foreground">{t("account.twoFactor.emailHint")}</div>
                    </div>
                    <div className="grid gap-2 max-w-xs">
                      <Label htmlFor="emailEnableCode">{t("account.twoFactor.verificationCode")}</Label>
                      <Input
                        id="emailEnableCode"
                        value={emailEnableCode}
                        onChange={(event) => setEmailEnableCode(event.target.value)}
                        placeholder={t("account.twoFactor.codePlaceholder")}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        disabled={!emailEnableRequested || twoFactorBusy}
                      />
                    </div>
                    <Button
                      type="button"
                      onClick={confirmEmailEnable}
                      disabled={!emailEnableRequested || !emailEnableCode || twoFactorBusy}
                    >
                      {twoFactorBusy ? t("account.twoFactor.enabling") : t("account.twoFactor.enable")}
                    </Button>
                  </div>
                ) : null}

                {enableMethod === "totp" ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" onClick={generateTotpSetup} disabled={!reauthReady || twoFactorBusy}>
                        {totpSetupState ? t("account.twoFactor.regenerateQr") : t("account.twoFactor.generateQr")}
                      </Button>
                      <div className="text-sm text-muted-foreground">{t("account.twoFactor.setupExpires")}</div>
                    </div>

                    {totpSetupState ? (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-xl border border-border bg-background p-4">
                          <div className="text-sm font-semibold">{t("account.twoFactor.qrCode")}</div>
                          <div className="mt-3 flex items-center justify-center">
                            <img
                              src={totpSetupState.qrCode}
                              alt={t("account.twoFactor.qrAlt")}
                              className="h-40 w-40 rounded-lg border border-border bg-card p-2"
                            />
                          </div>
                        </div>
                        <div className="space-y-3 rounded-xl border border-border bg-background p-4">
                          <div>
                            <div className="text-sm font-semibold">{t("account.twoFactor.manualSetup")}</div>
                            <div className="text-xs text-muted-foreground">{t("account.twoFactor.manualSetupHint")}</div>
                          </div>
                          <div className="relative">
                            <Input readOnly value={totpSetupState.secret} className="pr-16 font-mono text-xs" />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-1 top-1/2 -translate-y-1/2"
                              onClick={() => copyText(totpSetupState.secret)}
                            >
                              {t("account.common.copy")}
                            </Button>
                          </div>
                          <div className="grid gap-2 max-w-xs">
                            <Label htmlFor="totpCode">{t("account.twoFactor.verificationCode")}</Label>
                            <Input
                              id="totpCode"
                              value={totpCode}
                              onChange={(event) => setTotpCode(event.target.value)}
                              placeholder={t("account.twoFactor.codePlaceholder")}
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              disabled={twoFactorBusy}
                            />
                          </div>
                          <Button type="button" onClick={confirmTotpEnable} disabled={!totpCode || twoFactorBusy}>
                            {twoFactorBusy ? t("account.twoFactor.enabling") : t("account.twoFactor.enable")}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <Button type="button" variant="ghost" onClick={resetTwoFactorFlows}>
                  {t("account.common.cancel")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            {!disableFlowOpen ? (
              <Button type="button" variant="secondary" onClick={startDisable}>
                {t("account.twoFactor.disable")}
              </Button>
            ) : (
              <div className="space-y-4 rounded-xl border border-border bg-muted/10 p-4">
                <div className="space-y-1">
                  <div className="font-semibold">{t("account.twoFactor.disable")}</div>
                  <div className="text-sm text-muted-foreground">{t("account.twoFactor.disableHint")}</div>
                </div>

                {reauthFields}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={confirmDisable}
                    disabled={!reauthReady || twoFactorBusy}
                  >
                    {twoFactorBusy ? t("account.twoFactor.disabling") : t("account.twoFactor.disable")}
                  </Button>
                  <Button type="button" variant="ghost" onClick={resetTwoFactorFlows}>
                    {t("account.common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
