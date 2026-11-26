/**
 * ACCT-UNPAID-06 / ACCT-UNPAID-04: the key step's place when the API refused the account's first library because the
 * plan has ended. The plan screen is not reachable during setup, so Renew renews the account's current plan right
 * there through the same plan change as the plan screen, reads the account's access again and, once it is paid, goes
 * on with the kept key (Try again). Mounted only on that screen, so setup never listens for payments otherwise.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { DesktopUnpaidSetupStep } from "@space/desktop-shell/components";
import { MASCOT_GLOW } from "@space/ui/floating-mascot";
import mascotUrl from "@space/parrot-core/mascot.webp";
import { paymentPageLang, type BillingStatus } from "@space/shared/billingCheckout";
import { isAccessUnpaid } from "@space/shared/effectiveAccess";
import { unpaidLibrarySetupText } from "@space/shared/unpaidLibrarySetup";
import type { ParrotLanguage } from "../../shared/ipc";
import type { Translate } from "./i18n";
import { planResultText, useParrotPlanChange } from "./Plans";
const log = (message: string, details?: Record<string, unknown>) => console.info(`[parrot:unpaid-setup] ${message}`, details ?? {});

const useParrotUnpaidSetupRenew = (t: Translate, language: ParrotLanguage) => {
  const planChange = useParrotPlanChange();
  const [renewing, setRenewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const notRenewed = unpaidLibrarySetupText(language, "parrot", "computer").notRenewed;

  const renew = async (): Promise<boolean> => {
    if (renewing) return false;
    setRenewing(true);
    setMessage(null);
    try {
      const [sub, status] = await Promise.all([window.parrot.getSubscription(), window.parrot.getBillingStatus()]);
      if (!sub.ok) {
        log("subscription unreadable", { code: sub.code });
        setMessage(notRenewed);
        return false;
      }
      const billing: BillingStatus | null = status.ok ? status.value : null;
      const request = {
        plan: sub.value.plan,
        billingPeriod: sub.value.billingPeriod ?? "monthly",
        addonCount: sub.value.plan === "tier3" ? sub.value.storageAddonCount : 0,
      } as const;
      log("renew requested", { ...request, provider: billing?.provider ?? null });
      const result = await planChange.run({ ...request, lang: paymentPageLang(language) }, billing);
      log("renew result", { result });
      // Applied or booked: read the access again. Anything else is said as the plan screen says it.
      const applied =
        result.kind === "changed" ||
        result.kind === "paid" ||
        result.kind === "endsAt" ||
        result.kind === "booked" ||
        result.kind === "bookingCancelled";
      if (!applied) {
        setMessage(planResultText(t, result, language));
        return false;
      }
      const access = await window.parrot.getAccountAccess();
      const paid = access.ok && !isAccessUnpaid(access.value);
      log("access after renew", { paid, state: access.ok ? (access.value?.state ?? null) : access.code });
      if (!paid) setMessage(notRenewed);
      return paid;
    } catch (error) {
      log("renew failed", { error: error instanceof Error ? error.message : String(error) });
      setMessage(notRenewed);
      return false;
    } finally {
      setRenewing(false);
    }
  };

  return { renew, renewing, message };
};

type Props = {
  t: Translate;
  language: ParrotLanguage;
  progress: ComponentProps<typeof DesktopUnpaidSetupStep>["progress"];
  secondary: ReactNode;
  /** Publishes the kept key again; the step stays while the API still refuses it. */
  onTryAgain: () => void;
  tryingAgain: boolean;
  /** The kept key was refused again after Try again or a renewal: the plan is still not renewed. */
  refusedAgain: boolean;
};

export const ParrotUnpaidSetupStep = ({ t, language, progress, secondary, onTryAgain, tryingAgain, refusedAgain }: Props) => {
  const { renew, renewing, message } = useParrotUnpaidSetupRenew(t, language);
  const onRenew = async () => {
    if (await renew()) onTryAgain();
  };
  return (
    <DesktopUnpaidSetupStep
      language={language}
      app="parrot"
      progress={progress}
      mascotSrc={mascotUrl}
      mascotGlowClassName={MASCOT_GLOW.parrot}
      onRenew={() => void onRenew()}
      renewing={renewing}
      onTryAgain={onTryAgain}
      tryingAgain={tryingAgain}
      message={message ?? (refusedAgain ? unpaidLibrarySetupText(language, "parrot", "computer").notRenewed : null)}
      secondary={secondary}
    />
  );
};
