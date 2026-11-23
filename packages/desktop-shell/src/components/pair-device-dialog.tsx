import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
  SHORT_CODE_LENGTH,
  formatCheckCode,
  type ApprovePairingProof,
  type ApprovePairingResult,
  type PairingRequestView,
} from "@space/pairing-crypto";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@space/ui";
import { SPACE_APP_NAMES } from "@space/shared/appScope";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { retryAfterSecondsToMinutes, signInErrorText } from "@space/shared/signInError";
import { pairDeviceText, type PairDeviceKind } from "./pair-device-strings";
import { ShortCodeInput } from "./short-code-input";

const PAIR_DEVICE_KINDS: readonly PairDeviceKind[] = ["desktop", "mobile", "tv", "kodi", "jellyfin", "web"];

/** The kind a waiting device declared (`web` for a browser on a web player), `other` when unknown. */
export const pairDeviceKind = (deviceType: string): PairDeviceKind =>
  PAIR_DEVICE_KINDS.find((kind) => kind === deviceType.toLowerCase()) ?? "other";

/**
 * The three steps, as plain results so they can run in the window (Badger) or in the main process over IPC (Parrot,
 * whose token and library key never reach the window). `lookup` finds the request and runs the check (PRIV-PAIR-01,
 * `runPairingCheck`), so its request carries the `check` code; `approve` seals the key for `request` only; its proof is
 * the account password, or `{ code }` for an account without one.
 */
export type PairDeviceActions<R extends PairingRequestView = PairingRequestView> = {
  lookup: (code: string) => Promise<ApprovePairingResult<R>>;
  approve: (request: R, proof: ApprovePairingProof) => Promise<ApprovePairingResult<unknown>>;
  deny: (request: R) => Promise<ApprovePairingResult<unknown>>;
};

type Stage<R> =
  | { name: "code"; error: string | null }
  | { name: "looking" }
  /**
   * Who is asking, the warning, and the account password (or, without one, the code once `codeAsked` says which);
   * `error` once the API refused the last password or code.
   */
  | { name: "confirm"; request: R; error: string | null; codeAsked: "email" | "totp" | null }
  | { name: "approving"; request: R; codeAsked: "email" | "totp" | null }
  | { name: "done"; request: R; added: boolean }
  | { name: "failed"; message: string };

/**
 * ACCT-PAIR-01 / ACCT-PAIR-02: approve another device (a TV, a phone, a browser, another computer) from this computer.
 * The user types the code that device shows (or pastes its QR link); the dialog names the device and its type with the
 * warning to approve only a code shown on a screen in front of them, shows the six-digit check code and asks whether
 * the device shows the same (PRIV-PAIR-01: Decline when not), then asks for the account password, which the
 * API checks before approving. A wrong password leaves the request pending and asks again. An account without a
 * password (`hasPassword` false, ACCT-AUTH-04) is asked a code instead: Approve first asks the API for it (it emails one
 * unless the authenticator app is on), then the code field appears.
 */
export function PairDeviceDialog<R extends PairingRequestView>({
  open,
  onOpenChange,
  actions,
  language,
  onApproved,
  hasPassword = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: PairDeviceActions<R>;
  /** The app's language; the dialog's text is shared by Badger and Parrot desktop (`pair-device-strings.ts`). */
  language: ClientUiLanguage;
  onApproved?: () => void;
  /** The signed-in account's `hasPassword`: false asks a code instead of the password. */
  hasPassword?: boolean;
}) {
  const t = pairDeviceText(language);
  const [stage, setStage] = useState<Stage<R>>({ name: "code", error: null });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [approveCode, setApproveCode] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A 429 shows the shared "Too many attempts. Try again in N minutes." with the API's wait (ACCT-AUTH-11).
  const errorText = (failure: Extract<ApprovePairingResult<unknown>, { ok: false }>) =>
    failure.kind === "rate_limited"
      ? signInErrorText(language, "tooManyAttempts", retryAfterSecondsToMinutes(failure.retryAfterSeconds))
      : t(`errors.${failure.kind}`);

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== SHORT_CODE_LENGTH) return;
    setStage({ name: "looking" });
    const result = await actions.lookup(code).catch((): ApprovePairingResult<R> => ({ ok: false, kind: "unknown" }));
    if (!mounted.current) return;
    setStage(result.ok ? { name: "confirm", request: result.value, error: null, codeAsked: null } : { name: "code", error: errorText(result) });
  };

  const approve = async (event: FormEvent, request: R, codeAsked: "email" | "totp" | null) => {
    event.preventDefault();
    if (hasPassword ? !password : codeAsked !== null && !approveCode.trim()) return;
    setStage({ name: "approving", request, codeAsked });
    // Without a password, the first Approve sends an empty code: the API answers which code it wants.
    const proof: ApprovePairingProof = hasPassword ? password : { code: codeAsked ? approveCode : "" };
    const result = await actions
      .approve(request, proof)
      .catch((): ApprovePairingResult<unknown> => ({ ok: false, kind: "unknown" }));
    setPassword("");
    setApproveCode("");
    if (!mounted.current) return;
    if (result.ok) {
      setStage({ name: "done", request, added: true });
      onApproved?.();
    } else if (result.kind === "wrong_password") {
      setStage({ name: "confirm", request, error: errorText(result), codeAsked: null });
    } else if (result.kind === "code_required") {
      setStage({ name: "confirm", request, error: null, codeAsked: result.method ?? "email" });
    } else if (result.kind === "wrong_code") {
      setStage({ name: "confirm", request, error: errorText(result), codeAsked: result.method ?? codeAsked ?? "email" });
    } else {
      setStage({ name: "failed", message: errorText(result) });
    }
  };

  // A failed decline is not shown: the code expires by itself anyway.
  const deny = async (request: R) => {
    setPassword("");
    setApproveCode("");
    await actions.deny(request).catch(() => undefined);
    if (mounted.current) setStage({ name: "done", request, added: false });
  };

  let body: ReactNode;
  if (stage.name === "code" || stage.name === "looking") {
    const busy = stage.name === "looking";
    body = (
      <form className="grid gap-4" onSubmit={(event) => void submitCode(event)} data-testid="pair-approve-code-step">
        <div className="grid gap-2">
          <Label htmlFor="pairApproveCode">{t("code.label")}</Label>
          {/* ACCT-PAIR-01: 8 boxes in two groups of 4; typed or pasted with or without a dash or spaces, in any case. */}
          <ShortCodeInput id="pairApproveCode" testId="pair-approve-code" value={code} onChange={setCode} autoFocus disabled={busy} />
        </div>
        {stage.name === "code" && stage.error ? (
          <p className="text-sm text-destructive" role="alert" data-testid="pair-approve-error">
            {stage.error}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} data-testid="pair-approve-cancel">
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={busy || code.length !== SHORT_CODE_LENGTH} data-testid="pair-approve-continue">
            {busy ? t("code.checking") : t("code.submit")}
          </Button>
        </DialogFooter>
      </form>
    );
  } else if (stage.name === "confirm" || stage.name === "approving") {
    const { request, codeAsked } = stage;
    const busy = stage.name === "approving";
    body = (
      <form className="grid gap-4" onSubmit={(event) => void approve(event, request, codeAsked)} data-testid="pair-approve-confirm-step">
        <p className="text-base font-medium" data-testid="pair-approve-question">
          {t(request.purpose === "key" ? "confirm.keyQuestion" : "confirm.question", {
            app: SPACE_APP_NAMES[request.app],
            name: request.deviceName,
            type: t(`type.${pairDeviceKind(request.deviceType)}`),
          })}
        </p>
        <div
          role="alert"
          data-testid="pair-approve-warning"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t("confirm.warning")}</span>
        </div>
        {request.check && !request.check.confirmedByQr ? (
          <div className="grid gap-1 rounded-md border px-3 py-2" data-testid="pair-approve-check">
            <p className="text-sm">{t("check.question", { name: request.deviceName })}</p>
            <p className="text-3xl font-semibold tracking-widest tabular-nums" data-testid="pair-approve-check-code">
              {formatCheckCode(request.check.code)}
            </p>
            <p className="text-xs text-muted-foreground">{t("check.hint")}</p>
          </div>
        ) : null}
        {hasPassword ? (
          <div className="grid gap-2">
            <Label htmlFor="pairApprovePassword">{t("confirm.passwordLabel")}</Label>
            <Input
              id="pairApprovePassword"
              data-testid="pair-approve-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{t("confirm.passwordHint")}</p>
          </div>
        ) : (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground" data-testid="pair-approve-no-password">
              {t("confirm.noPasswordHint")}
            </p>
            {codeAsked ? (
              <>
                <Label htmlFor="pairApproveCodeProof">{t("confirm.codeLabel")}</Label>
                <Input
                  id="pairApproveCodeProof"
                  data-testid="pair-approve-proof-code"
                  value={approveCode}
                  onChange={(event) => setApproveCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  disabled={busy}
                />
                <p className="text-xs text-muted-foreground" role="status" data-testid="pair-approve-code-notice">
                  {t(codeAsked === "totp" ? "confirm.codeTotp" : "confirm.codeSentEmail")}
                </p>
              </>
            ) : null}
          </div>
        )}
        {stage.name === "confirm" && stage.error ? (
          <p className="text-sm text-destructive" role="alert" data-testid="pair-approve-error">
            {stage.error}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void deny(request)} data-testid="pair-approve-deny">
            {t("confirm.deny")}
          </Button>
          <Button
            type="submit"
            disabled={busy || (hasPassword ? !password : codeAsked !== null && !approveCode.trim())}
            data-testid="pair-approve-approve"
          >
            {busy ? t("confirm.approving") : t("confirm.approve")}
          </Button>
        </DialogFooter>
      </form>
    );
  } else {
    const message =
      stage.name === "failed"
        ? stage.message
        : stage.added
          ? t(stage.request.purpose === "key" ? "done.keySent" : "done.added", { name: stage.request.deviceName })
          : t("done.denied", { name: stage.request.deviceName });
    body = (
      <div className="grid gap-4" data-testid="pair-approve-result">
        <p className={stage.name === "failed" ? "text-sm text-destructive" : "text-sm"} role={stage.name === "failed" ? "alert" : "status"}>
          {message}
        </p>
        <DialogFooter className="gap-2">
          {stage.name === "failed" ? (
            <Button type="button" variant="secondary" onClick={() => setStage({ name: "code", error: null })} data-testid="pair-approve-try-again">
              {t("tryAgain")}
            </Button>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)} data-testid="pair-approve-close">
            {t("close")}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="pair-approve-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
