/**
 * ACCT-PAIR-07: "Continue with your Badger account" (and its Parrot twin) above the normal sign-in on a computer. The
 * sister app already signed in on this computer approves the sign-in through the local channel; nothing to type.
 *
 * States: the offer (the sister app's real icon, its account's email on one button), waiting (with Cancel), and the
 * one-line failure that leaves the normal sign-in below it. "Use another account" hides the card.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { siblingAppOf } from "@space/shared/appScope";
import type { SpaceAppId } from "@space/shared/appScope";
import badgerIcon from "../assets/badger-app-icon.png";
import parrotIcon from "../assets/parrot-app-icon.png";
import type { PairedKeyCheck, PairingHandOver } from "../pairing/types";
import type { SiblingOffer, SiblingSignInActions } from "../sibling/types";
import { NoticeSurface } from "./notice-surface";
import { sameDeviceSignInText } from "./same-device-sign-in-strings";

const APP_NAMES: Partial<Record<SpaceAppId, string>> = { badger: "Badger", parrot: "Parrot" };
const APP_ICONS: Partial<Record<SpaceAppId, string>> = { badger: badgerIcon, parrot: parrotIcon };

type Phase = "loading" | "offer" | "waiting" | "failed" | "hidden";

export type SameDeviceSignInProps<A = PairingHandOver> = {
  language: ClientUiLanguage;
  /** The app showing the card (the one signing in). */
  app: SpaceAppId;
  actions: SiblingSignInActions<A>;
  /** Finishes the sign-in exactly as after a paired sign-in; "mismatch" shows the failure line. */
  onApproved: (approved: { status: "approved" } & A) => Promise<PairedKeyCheck>;
  /** "Use another account": the card is gone, the normal sign-in stays. */
  onHide?: () => void;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

export function SameDeviceSignIn<A = PairingHandOver>({ language, app, actions, onApproved, onHide, log }: SameDeviceSignInProps<A>) {
  const [offer, setOffer] = useState<SiblingOffer | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const mounted = useRef(true);
  const t = sameDeviceSignInText(language);

  useEffect(() => {
    mounted.current = true;
    void actions.offer().then(
      (found) => {
        if (!mounted.current) return;
        // Only the sister app's account is offered: anything else on the channel is ignored.
        const valid = found && found.app === siblingAppOf(app) && APP_NAMES[found.app] ? found : null;
        log?.("same-device sign-in: offer", { app, offered: valid ? valid.app : null });
        setOffer(valid);
        setPhase(valid ? "offer" : "hidden");
      },
      () => mounted.current && setPhase("hidden"),
    );
    return () => {
      mounted.current = false;
    };
    // The offer is read once per bridge: a new `log` closure on each render of the screen must not read it again.
  }, [actions, app]);

  const signIn = useCallback(async () => {
    setPhase("waiting");
    try {
      const result = await actions.signIn();
      if (!mounted.current) return;
      log?.("same-device sign-in: ended", { status: result.status });
      if (result.status === "cancelled") return setPhase("offer");
      if (result.status === "failed") return setPhase("failed");
      const check = await onApproved(result);
      if (mounted.current && check !== "verified") setPhase("failed");
    } catch (err) {
      log?.("same-device sign-in: failed", { message: err instanceof Error ? err.message : String(err) });
      if (mounted.current) setPhase("failed");
    }
  }, [actions, log, onApproved]);

  if (!offer || phase === "loading" || phase === "hidden") return null;
  const other = APP_NAMES[offer.app] ?? offer.app;

  if (phase === "failed") {
    return (
      <div className="w-full min-w-0" data-testid="same-device-sign-in-failure">
        <NoticeSurface tone="error" className="w-full">
          {t("failure", { Other: other })}
        </NoticeSurface>
      </div>
    );
  }

  const [before, after] = t("button", { Other: other }).split("{email}");
  // `min-w-0`: the sign-in forms are grids and flex columns, whose items never shrink below their content by default;
  // the one-line email button would then widen the whole form past its card. The email truncates instead.
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-3 rounded-2xl border-[1.5px] border-primary/60 bg-primary/[0.09] px-4 py-3.5 text-left"
      data-testid="same-device-sign-in-card"
    >
      <div className="flex items-center gap-3.5">
        <img
          src={APP_ICONS[offer.app]}
          alt=""
          aria-hidden
          className="h-12 w-12 flex-none rounded-xl"
          data-testid="same-device-sign-in-icon"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-bold text-foreground">{t("title", { Other: other })}</span>
          <span className="block text-[13px] text-muted-foreground">{t("body", { Other: other })}</span>
        </span>
      </div>
      {phase === "waiting" ? (
        <div className="flex h-10 items-center gap-3">
          <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground" role="status">
            {t("waiting", { Other: other })}
          </span>
          <button
            type="button"
            onClick={() => void actions.cancel()}
            className="flex-none rounded-md px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="same-device-sign-in-cancel"
          >
            {t("cancel")}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void signIn()}
            title={offer.email}
            className="flex h-10 w-full min-w-0 items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            data-testid="same-device-sign-in-continue"
          >
            {before ? <span className="flex-none whitespace-pre">{before}</span> : null}
            <span className="min-w-0 truncate" data-testid="same-device-sign-in-email">
              {offer.email}
            </span>
            {after ? <span className="flex-none whitespace-pre">{after}</span> : null}
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase("hidden");
              onHide?.();
            }}
            className="self-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="same-device-sign-in-other-account"
          >
            {t("link")}
          </button>
        </>
      )}
    </div>
  );
}
