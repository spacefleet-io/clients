/**
 * ACCT-UNPAID-06 / ACCT-UNPAID-04: the setup step's place when the API refused to create the library because the plan
 * has ended. Settings is not reachable before the key is kept, so Renew renews the account's current plan right there
 * through the same plan change as Settings → Account, reads the account again and, once it is paid, runs the step
 * again with the kept key (Try again). Mounted only on that screen, so the key step reads no billing otherwise.
 */
import { useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { DesktopUnpaidSetupStep } from "@space/desktop-shell/components";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { paymentPageLang } from "@space/shared/billingCheckout";
import { resolveEffectiveAccess } from "@space/shared/effectiveAccess";
import { unpaidLibrarySetupText } from "@space/shared/unpaidLibrarySetup";
import mascotWebp from "@/assets/mascot.webp";
import { getMe, getSubscription } from "@/api";
import { useAuth } from "@/auth";
import { rendererLogger } from "@/logger";
import { planChangeResultMessage, useAccountPlanChange, useBillingStatus } from "@/lib/planChange";

const log = rendererLogger.child({ scope: "onboarding.unpaid-renew" });

const useUnpaidSetupRenew = (notRenewed: string) => {
  const { token, setUser } = useAuth();
  const { t, i18n } = useTranslation();
  const planChange = useAccountPlanChange();
  const { billing } = useBillingStatus();
  const [renewing, setRenewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const renew = async (): Promise<boolean> => {
    if (!token || renewing) return false;
    setRenewing(true);
    setMessage(null);
    try {
      const subscription = await getSubscription(token);
      const request = {
        plan: subscription.plan,
        billingPeriod: subscription.billingPeriod ?? "monthly",
        addonCount: subscription.plan === "tier3" ? subscription.storageAddonCount : 0,
      } as const;
      log.info({ ...request, provider: billing?.provider ?? null }, "renew.requested");
      const result = await planChange.run({ ...request, lang: paymentPageLang(i18n.language) }, billing);
      log.info({ result }, "renew.result");
      // Applied or booked: read the account again to see whether it is paid. Anything else is said as Settings says it.
      const applied =
        result.kind === "changed" ||
        result.kind === "paid" ||
        result.kind === "endsAt" ||
        result.kind === "booked" ||
        result.kind === "bookingCancelled";
      if (!applied) {
        setMessage(planChangeResultMessage(t, result, i18n.language));
        return false;
      }
      const me = await getMe(token);
      const access = me.access ?? me.user.access;
      setUser({ ...me.user, access });
      const paid = resolveEffectiveAccess(access ?? null, Date.now())?.state !== "unpaid";
      log.info({ paid, accessState: access?.state ?? null }, "renew.access");
      if (!paid) setMessage(notRenewed);
      return paid;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "renew.failed");
      setMessage(notRenewed);
      return false;
    } finally {
      setRenewing(false);
    }
  };

  return { renew, renewing, message };
};

type Props = {
  language: ClientUiLanguage;
  progress: ComponentProps<typeof DesktopUnpaidSetupStep>["progress"];
  /** Runs the library step again with the kept key; the screen stays while the API still refuses it. */
  onTryAgain: () => void;
  tryingAgain: boolean;
  /** The kept key was refused again after Try again or a renewal: the plan is still not renewed. */
  refusedAgain: boolean;
};

export function UnpaidSetupStep({ language, progress, onTryAgain, tryingAgain, refusedAgain }: Props) {
  const { t } = useTranslation();
  const notRenewed = unpaidLibrarySetupText(language, "badger", "computer").notRenewed;
  const { renew, renewing, message } = useUnpaidSetupRenew(notRenewed);
  const onRenew = async () => {
    if (await renew()) onTryAgain();
  };
  return (
    <DesktopUnpaidSetupStep
      language={language}
      app="badger"
      progress={progress}
      mascotSrc={mascotWebp}
      mascotAlt={t("brand.mascotAlt")}
      onRenew={() => void onRenew()}
      renewing={renewing}
      onTryAgain={onTryAgain}
      tryingAgain={tryingAgain}
      message={message ?? (refusedAgain ? notRenewed : null)}
    />
  );
}
