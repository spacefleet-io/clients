import { useCallback, useEffect, useRef, useState } from "react";
import { formatCheckCode, shortCodeGroups } from "@space/pairing-crypto";
import { Button } from "@space/ui";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { RATE_LIMIT_DEFAULT_MINUTES, signInErrorText } from "@space/shared/signInError";
import { NoticeSurface } from "./notice-surface";
import { pairWithPhoneText, type PairWithPhoneStringKey } from "./pair-with-phone-strings";
import type {
  PairedKeyCheck,
  PairingFailure,
  PairingHandOver,
  PairingMode,
  PairingPollResult,
  PairingStart,
  PairingStartOptions,
  PairingStartResult,
} from "../pairing/types";

export const PAIRING_POLL_INTERVAL_MS = 2000;
const COUNTDOWN_TICK_MS = 1000;

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; request: PairingStart }
  | { kind: "verifying" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; messageKey: PairWithPhoneStringKey }
  /** The API refused for now (429): "Too many attempts. Try again in N minutes." (ACCT-AUTH-11). */
  | { kind: "rateLimited"; minutes: number };

const FAILURE_MESSAGE: Record<Exclude<PairingFailure, "rate_limited">, PairWithPhoneStringKey> = {
  unreachable: "unreachable",
  failed: "failed",
};

const formatCountdown = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** The new-device calls, run in the main process (the keypair and poll secret never reach the window). */
export type PairWithPhoneActions<A = PairingHandOver> = {
  start: (options?: PairingStartOptions) => Promise<PairingStartResult>;
  poll: (requestId: string) => Promise<PairingPollResult<A>>;
  cancel: () => Promise<unknown> | void;
};

export type PairWithPhoneLog = {
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
};

type Props<A> = {
  language: ClientUiLanguage;
  actions: PairWithPhoneActions<A>;
  /** `sign_in` (default): the sign-in screen. `key`: the key screen of a signed-in computer asks only for the key. */
  mode?: PairingMode;
  /** Stores the session and library key; resolves "mismatch" (with nothing stored) when the key is wrong. */
  onApproved: (approved: { status: "approved" } & A) => Promise<PairedKeyCheck>;
  /** Shown as a link under the code ("email and password instead", or "type the key instead" in key mode); omit to hide it. */
  onBack?: () => void;
  log?: PairWithPhoneLog;
};

const consoleLog: PairWithPhoneLog = {
  info: (message, extra) => console.info(`[pair-with-phone] ${message}`, extra ?? ""),
  warn: (message, extra) => console.warn(`[pair-with-phone] ${message}`, extra ?? ""),
  error: (message, extra) => console.error(`[pair-with-phone] ${message}`, extra ?? ""),
};

/**
 * ACCT-PAIR-01 / ACCT-PAIR-05: the "Sign in with your phone" screen of Badger desktop and Parrot desktop: QR code,
 * short code, countdown, new code. A signed-in Badger or Parrot app on the same account approves it. In key mode the
 * same screen is the key screen's "Get your library key from another device".
 */
export default function PairWithPhone<A = PairingHandOver>({
  language,
  actions,
  mode = "sign_in",
  onApproved,
  onBack,
  log = consoleLog,
}: Props<A>) {
  const t = pairWithPhoneText(language);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  // PRIV-PAIR-01: the six digits both screens show once the approving app connected; null until then.
  const [checkCode, setCheckCode] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Bumped on every new code and on unmount; a stale poll or start result checks it before touching state.
  const generation = useRef(0);
  const onApprovedRef = useRef(onApproved);
  const actionsRef = useRef(actions);
  const logRef = useRef(log);
  useEffect(() => {
    onApprovedRef.current = onApproved;
    actionsRef.current = actions;
    logRef.current = log;
  }, [onApproved, actions, log]);

  const startNewCode = useCallback(async () => {
    const mine = ++generation.current;
    setPhase({ kind: "starting" });
    setCheckCode(null);
    let result: PairingStartResult;
    try {
      result = await (mode === "key" ? actionsRef.current.start({ mode: "key" }) : actionsRef.current.start());
    } catch (error) {
      logRef.current.error("pairing start threw", { error: String(error) });
      result = { ok: false, error: "failed" };
    }
    if (mine !== generation.current) return;
    if (!result.ok) {
      logRef.current.warn("pairing start failed", { error: result.error, retryAfterMinutes: result.retryAfterMinutes ?? null });
      setPhase(
        result.error === "rate_limited"
          ? { kind: "rateLimited", minutes: result.retryAfterMinutes ?? RATE_LIMIT_DEFAULT_MINUTES }
          : { kind: "error", messageKey: FAILURE_MESSAGE[result.error] },
      );
      return;
    }
    logRef.current.info("pairing code ready", { requestId: result.requestId, expiresAt: result.expiresAt, mode });
    setPhase({ kind: "waiting", request: result });
    setNow(Date.now());
  }, [mode]);

  useEffect(() => {
    void startNewCode();
    return () => {
      generation.current += 1;
      void actionsRef.current.cancel();
    };
  }, [startNewCode]);

  const request = phase.kind === "waiting" ? phase.request : null;
  const remainingMs = request ? Date.parse(request.expiresAt) - now : 0;
  const codeLapsed = request !== null && remainingMs <= 0;

  useEffect(() => {
    if (!request) return;
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [request]);

  useEffect(() => {
    if (!codeLapsed) return;
    logRef.current.info("pairing code expired locally");
    generation.current += 1;
    void actionsRef.current.cancel();
    setPhase({ kind: "expired" });
  }, [codeLapsed]);

  useEffect(() => {
    if (!request) return;
    const mine = generation.current;
    const finish = async () => {
      let poll: PairingPollResult<A>;
      try {
        poll = await actionsRef.current.poll(request.requestId);
      } catch (error) {
        poll = { ok: false, error: "failed" };
        logRef.current.warn("pairing poll threw", { error: String(error) });
      }
      if (mine !== generation.current) return true;
      if (!poll.ok) {
        // A dropped connection or a hiccup: keep waiting, the next poll tries again.
        logRef.current.warn("pairing poll failed", { error: poll.error });
        return false;
      }
      logRef.current.info("pairing poll", { requestId: request.requestId, status: poll.status });
      switch (poll.status) {
        case "pending":
          if (poll.checkCode) setCheckCode(poll.checkCode);
          return false;
        case "expired":
          setPhase({ kind: "expired" });
          return true;
        case "denied":
          setPhase({ kind: "denied" });
          return true;
        case "key_unreadable":
          setPhase({ kind: "error", messageKey: "keyUnreadable" });
          return true;
        case "approved": {
          setPhase({ kind: "verifying" });
          try {
            const check = await onApprovedRef.current(poll as { status: "approved" } & A);
            if (mine !== generation.current) return true;
            logRef.current.info("paired sign-in finished", { check });
            if (check === "mismatch") setPhase({ kind: "error", messageKey: "keyMismatch" });
          } catch (error) {
            logRef.current.error("paired sign-in failed", { error: String(error) });
            if (mine === generation.current) setPhase({ kind: "error", messageKey: FAILURE_MESSAGE.failed });
          }
          return true;
        }
      }
    };
    let timer: number | undefined;
    const tick = async () => {
      const done = await finish();
      if (!done && mine === generation.current) timer = window.setTimeout(() => void tick(), PAIRING_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void tick(), PAIRING_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [request]);

  const needsNewCode = phase.kind === "expired" || phase.kind === "denied" || phase.kind === "error" || phase.kind === "rateLimited";
  const notice =
    phase.kind === "expired"
      ? t("expired")
      : phase.kind === "denied"
        ? t("denied")
        : phase.kind === "error"
          ? t(phase.messageKey)
          : phase.kind === "rateLimited"
            ? signInErrorText(language, "tooManyAttempts", phase.minutes)
            : null;

  return (
    <div className="grid gap-4 text-center" data-testid="pair-with-phone">
      <h2 className="text-lg font-semibold">{t(mode === "key" ? "keyTitle" : "title")}</h2>
      <p className="text-sm text-muted-foreground">{t(mode === "key" ? "keyInstructions" : "instructions")}</p>

      {notice ? <NoticeSurface tone={phase.kind === "expired" ? "info" : "error"}>{notice}</NoticeSurface> : null}

      {request ? (
        <>
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(request.qrSvg)}`}
            alt={t("qrAlt")}
            className="mx-auto h-48 w-48 rounded-lg bg-white"
            data-testid="pair-qr"
          />
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{t("codeLabel")}</span>
            {/* ACCT-PAIR-01: two groups of 4 with a gap, never a dash; copying it gives the plain 8 characters. */}
            <span className="font-mono text-2xl font-semibold tracking-[0.2em]" data-testid="pair-short-code">
              <span>{shortCodeGroups(request.shortCode)[0]}</span>
              <span className="ml-3">{shortCodeGroups(request.shortCode)[1]}</span>
            </span>
          </div>
          {checkCode ? (
            <div className="grid gap-1 rounded-lg border p-3" data-testid="pair-check">
              <span className="text-xs text-muted-foreground">{t("checkLabel")}</span>
              <span className="font-mono text-3xl font-semibold tracking-[0.2em]" data-testid="pair-check-code">
                {formatCheckCode(checkCode)}
              </span>
              <span className="text-xs text-muted-foreground">{t("checkHint")}</span>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground" data-testid="pair-countdown">
            {t("expiresIn", { time: formatCountdown(remainingMs) })}
          </p>
          <p className="text-sm text-muted-foreground">{t(mode === "key" ? "keyWaiting" : "waiting")}</p>
        </>
      ) : null}

      {phase.kind === "starting" ? <p className="text-sm text-muted-foreground">{t("starting")}</p> : null}
      {phase.kind === "verifying" ? <p className="text-sm text-muted-foreground">{t("verifying")}</p> : null}

      {needsNewCode ? (
        <Button type="button" onClick={() => void startNewCode()}>
          {t("newCode")}
        </Button>
      ) : null}

      {onBack ? (
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={onBack}
        >
          {t(mode === "key" ? "typeKeyInstead" : "emailInstead")}
        </button>
      ) : null}
    </div>
  );
}
