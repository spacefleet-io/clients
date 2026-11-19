import { useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  KeySavedWarningDialog,
  Label,
  Spinner,
} from "@space/ui";
import { BadgerPhoneSignInCard, BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { LibraryKeyWordsGrid, LibraryKeyWordsInput } from "@space/ui/library-key-words";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { keySavedWarningText, type KeySavedWarningApp } from "@space/shared/keySavedWarning";
import { libraryKeyWordsText, type LibraryKeyInput } from "@space/shared/libraryKeyWords";
import { signInErrorText } from "@space/shared/signInError";
import PairWithPhone, { type PairWithPhoneActions, type PairWithPhoneLog } from "./pair-with-phone";
import { pairWithPhoneText } from "./pair-with-phone-strings";
import { libraryKeyStepText } from "./library-key-step-strings";
import type { PairedKeyCheck, PairingHandOver } from "../pairing/types";
import type { LibraryKeyEraseOutcome } from "../libraryKeyErase";

/** A typed key the 12 boxes accepted (checksum included). */
export type LibraryKeyTyped = Extract<LibraryKeyInput, { status: "ok" }>;

/** "Get the key from another device" (ACCT-PAIR-01): the app's pairing calls, run in its main process. */
export type LibraryKeyStepPairing<A = PairingHandOver> = {
  actions: PairWithPhoneActions<A>;
  /** Keeps the approved key and opens the library; resolves "mismatch" (nothing kept) when it is not the account's. */
  onApproved: (approved: { status: "approved" } & A) => Promise<PairedKeyCheck>;
  log?: PairWithPhoneLog;
};

type CommonProps = {
  language: ClientUiLanguage;
  app: KeySavedWarningApp;
  /** One sentence in the error colour above the main button (a refused key, a failed save). */
  error?: string | null;
  /** Shown left of the main button: the app's Back or other ways out of the step. */
  secondary?: ReactNode;
};

export type LibraryKeyShowProps = CommonProps & {
  mode: "show";
  /** The new key's 12 words. */
  words: readonly string[];
  /** The library is being made with the key: the main button waits. */
  saving?: boolean;
  /** "Yes, I understand" in the ACCT-DEV-04 warning, after "I've written it down". */
  onSaved: () => void;
  /** A quiet line under the step. */
  note?: ReactNode;
};

export type LibraryKeyEnterProps<A = PairingHandOver> = CommonProps & {
  mode: "enter";
  /** Opens the library with the typed key; the app sets `error` when it does not. */
  onSubmitKey: (key: LibraryKeyTyped) => Promise<void>;
  /** Omitted where the app cannot pair (no pairing bridge). */
  pairing?: LibraryKeyStepPairing<A>;
  /** A brand-new account makes its key here (a quiet line under the card); omitted when the account has a library. */
  onCreateKey?: () => Promise<void>;
  /**
   * Erases every library of the account (PRIV-KEY-01: one key per account) after re-authentication. Called without a
   * code to ask for one again ("Resend code"). On "erased" the dialog closes and the app moves on.
   */
  onErase: (password: string, twoFactorCode?: string) => Promise<LibraryKeyEraseOutcome>;
  /**
   * The signed-in account's `hasPassword` (default true). An account without a password (ACCT-AUTH-04) is asked no
   * password in the erase dialog: `onErase` gets an empty one and the code alone confirms it.
   */
  hasPassword?: boolean;
};

export type LibraryKeyStepProps<A = PairingHandOver> = LibraryKeyShowProps | LibraryKeyEnterProps<A>;

/**
 * UX-KEY-01: the library key step of Badger desktop and Parrot desktop, one component for both apps ("the setup step
 * to enter/save the key should be the same shared one between the 2 apps", Chris 2026-11-12). Showing a new key: its
 * 12 words, Copy, "I've written it down" then the ACCT-DEV-04 warning. Entering one: the 12 boxes, the error, Continue
 * bottom-right, an "or" line and the other-device card (ACCT-PAIR-01), then the "Lost your key?" line and its erase
 * dialog (type ERASE plus the password). The app frames it (page, card, title) and does the calls.
 */
export function LibraryKeyStep<A = PairingHandOver>(props: LibraryKeyStepProps<A>) {
  return props.mode === "show" ? <ShowKey {...props} /> : <EnterKey {...props} />;
}

function ErrorBox({ text }: { text: string | null | undefined }) {
  return text ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert" data-testid="library-key-step-error">
      {text}
    </div>
  ) : null;
}

function ShowKey({ language, app, error, secondary, words, saving = false, onSaved, note }: LibraryKeyShowProps) {
  const text = libraryKeyStepText(language, app);
  const warning = keySavedWarningText(language, app);
  const [copied, setCopied] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);

  const copy = async () => {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(libraryKeyWordsText(words));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm" data-testid="key-created-line">
        {warning.stepLine}
      </p>
      <div className="rounded-xl border border-border bg-muted/20 p-4" data-testid="key-created">
        <div className="flex items-start justify-between gap-3">
          <div className="text-xs text-muted-foreground">{text("fieldLabel")}</div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            onClick={() => void copy()}
            aria-label={text("copy")}
            data-testid="key-copy"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <LibraryKeyWordsGrid words={words} className="mt-2" />
      </div>
      <ErrorBox text={error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{secondary}</div>
        <Button type="button" className="ml-auto" disabled={saving} onClick={() => setWarningOpen(true)} data-testid="key-saved">
          {saving ? text("creating") : warning.saved}
        </Button>
      </div>
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
      <KeySavedWarningDialog
        open={warningOpen}
        text={warning}
        onBack={() => setWarningOpen(false)}
        onConfirm={() => {
          setWarningOpen(false);
          onSaved();
        }}
      />
    </div>
  );
}

function EnterKey<A>({
  language,
  app,
  error,
  secondary,
  onSubmitKey,
  pairing,
  onCreateKey,
  onErase,
  hasPassword = true,
}: LibraryKeyEnterProps<A>) {
  const text = libraryKeyStepText(language, app);
  const pairText = pairWithPhoneText(language);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<LibraryKeyInput>({ status: "empty" });
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);

  const submit = async (typed: LibraryKeyInput = result) => {
    if (typed.status !== "ok" || busy) return;
    setBusy(true);
    try {
      await onSubmitKey(typed);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!onCreateKey) return;
    setCreating(true);
    try {
      await onCreateKey();
    } finally {
      setCreating(false);
    }
  };

  if (pairing && pairingOpen) {
    return (
      <PairWithPhone<A>
        language={language}
        mode="key"
        actions={pairing.actions}
        onApproved={pairing.onApproved}
        onBack={() => setPairingOpen(false)}
        log={pairing.log}
      />
    );
  }

  return (
    <div className="space-y-4">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <LibraryKeyWordsInput
          id="existingKey"
          value={draft}
          onChange={(value, read) => {
            setDraft(value);
            setResult(read);
          }}
          text={{ label: text("fieldLabel"), checksum: text("checksum"), unknownMark: text("unknownMark") }}
          autoFocus
          disabled={busy}
          onSubmit={(typed) => void submit(typed)}
        />
        <ErrorBox text={error} />
        {/* UX-SETUP-08: the main button sits bottom-right; the app's other ways out sit left of it. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{secondary}</div>
          <Button type="submit" className="ml-auto" disabled={result.status !== "ok" || busy} data-testid="library-key-continue">
            {busy ? text("validating") : text("continue")}
          </Button>
        </div>
      </form>
      {/* Under Continue: an "or" line and the highlighted other-device card (the phone sign-in card's look). */}
      {pairing ? (
        <>
          <BadgerSignInDivider label={pairText("or")} testId="key-other-device-divider" />
          <BadgerPhoneSignInCard
            title={pairText("keyLink")}
            body={pairText("keyCard")}
            onClick={() => setPairingOpen(true)}
            testId="key-from-another-device"
          />
        </>
      ) : null}
      <div className="space-y-1 text-center text-xs text-muted-foreground">
        {onCreateKey ? (
          <p>
            <button
              type="button"
              className="underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
              disabled={creating}
              onClick={() => void create()}
              data-testid="key-create"
            >
              {creating ? <Spinner size="sm" /> : text("newKey")}
            </button>
          </p>
        ) : null}
        {/* Erasing is the only way on without the key: a quiet line that says what it does (it is not a recovery),
            turning to the danger colour on hover. */}
        <p>
          <button
            type="button"
            className="underline-offset-4 hover:text-destructive hover:underline"
            data-testid="key-lost-start-new-library"
            onClick={() => setEraseOpen(true)}
          >
            {text("lostKeyLink")}
          </button>
        </p>
        <p data-testid="key-lost-note">{text("lostKeyNote")}</p>
      </div>
      {eraseOpen ? (
        <EraseDialog
          language={language}
          app={app}
          onErase={onErase}
          hasPassword={hasPassword}
          onClose={() => setEraseOpen(false)}
          // Erasing is the last resort (Chris 2026-11-12): a signed-in Badger or Parrot elsewhere can hand the key over.
          onOtherDevice={
            pairing
              ? () => {
                  setEraseOpen(false);
                  setPairingOpen(true);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The erase confirmation: the app language's word for it (ERASE) typed, then the account password (and code). An account
 * without a password reads that a code confirms it instead; its first Erase asks the API, which emails the code.
 */
function EraseDialog({
  language,
  app,
  onErase,
  onClose,
  onOtherDevice,
  hasPassword,
}: {
  language: ClientUiLanguage;
  app: KeySavedWarningApp;
  onErase: LibraryKeyEnterProps["onErase"];
  onClose: () => void;
  onOtherDevice?: () => void;
  hasPassword: boolean;
}) {
  const text = libraryKeyStepText(language, app);
  const confirmWord = text("eraseConfirmWord");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<"totp" | "email" | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim().toLocaleUpperCase() === confirmWord.toLocaleUpperCase();
  const passwordReady = !hasPassword || password.trim().length > 0;

  const failure = (outcome: Extract<LibraryKeyEraseOutcome, { status: "failed" }>) => {
    if (outcome.reason === "tooManyAttempts") return signInErrorText(language, "tooManyAttempts", outcome.minutes);
    if (outcome.reason === "invalidPassword") return text("eraseInvalidPassword");
    if (outcome.reason === "invalidCode") return text("eraseInvalidCode");
    return outcome.message ?? text("eraseFailed");
  };

  const run = async (resend: boolean) => {
    const setRunning = resend ? setResending : setBusy;
    setRunning(true);
    setError(null);
    if (!resend) setNotice(null);
    try {
      const outcome = await onErase(hasPassword ? password : "", resend ? undefined : code.trim() || undefined);
      if (outcome.status === "erased") onClose();
      else if (outcome.status === "codeNeeded") {
        setMethod(outcome.method);
        setNotice(text(resend ? "eraseCodeResent" : "eraseCodeSent"));
      } else setError(failure(outcome));
    } catch {
      setError(text("eraseFailed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="max-w-lg"
        // Cancel, not a field, has the focus when the dialog opens: erasing takes deliberate steps.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-destructive">{text("eraseTitle")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 py-2 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed && passwordReady && !busy) void run(false);
          }}
        >
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" data-testid="reset-warning">
            {text("eraseWarning")}
          </div>
          {onOtherDevice ? (
            <p className="text-muted-foreground" data-testid="reset-other-device">
              {text("eraseOtherDevice")}{" "}
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={onOtherDevice} data-testid="reset-other-device-link">
                {pairWithPhoneText(language)("keyLink")}
              </button>
            </p>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="resetConfirmWord">{text("eraseConfirmLabel", { word: confirmWord })}</Label>
            <Input
              id="resetConfirmWord"
              data-testid="reset-confirm-word"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
          {hasPassword ? (
            <div className="grid gap-2">
              <Label htmlFor="resetPassword">{text("erasePasswordLabel")}</Label>
              <Input
                id="resetPassword"
                data-testid="reset-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
          ) : (
            <p className="text-muted-foreground" data-testid="reset-no-password">
              {text("eraseNoPasswordHint")}
            </p>
          )}
          {method ? (
            <div className="grid gap-2">
              <Label htmlFor="resetCode">{text("eraseCodeLabel")}</Label>
              <Input
                id="resetCode"
                data-testid="reset-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
                autoComplete="one-time-code"
              />
              <div className="text-xs text-muted-foreground">
                {method === "totp" ? text("eraseCodeHintTotp") : text("eraseCodeHintEmail")}
              </div>
              {method === "email" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={() => void run(true)}
                  disabled={resending || !passwordReady}
                >
                  {resending ? text("eraseResending") : text("eraseResend")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{notice}</div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="reset-error">
              {error}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button ref={cancelRef} type="button" variant="outline" onClick={onClose} data-testid="reset-cancel">
              {text("eraseCancel")}
            </Button>
            <Button type="submit" variant="destructive" data-testid="reset-submit" disabled={!confirmed || !passwordReady || busy}>
              {busy ? text("eraseWorking") : text("eraseSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
