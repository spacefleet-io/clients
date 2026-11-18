import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createPlanChangeController,
  type PlanChangeApi,
  type PlanChangeController,
  type PlanChangeControllerOptions,
  type PlanChangeState,
} from "@space/shared/billingCheckout";

export type UsePlanChangeOptions = {
  /** The billing calls, bound to the signed-in account. Read at call time, so a new token is picked up. */
  api: PlanChangeApi;
  /** Opens Stancer's hosted payment page in the system browser. */
  openUrl: (url: string) => void;
  /**
   * Subscribes to the app's payment return link (ACCT-PAY-05): main hands over the payment id when the browser comes
   * back through `<app>://billing/return`; the hook then checks that payment at once. Returns the unsubscribe.
   */
  onPaymentReturn?: (listener: (paymentId: string) => void) => () => void;
  intervalMs?: number;
  timeoutMs?: number;
  log?: PlanChangeControllerOptions["log"];
};

export type UsePlanChangeResult = Omit<PlanChangeController, "getState" | "subscribe" | "dispose"> & {
  state: PlanChangeState;
};

/**
 * A plan change (ACCT-PAY-01) for a desktop screen: the shared controller from
 * `@space/shared/billingCheckout`, its state as React state, and a result check whenever the app's
 * window comes back into focus (the user is back from the browser's payment page). Badger and
 * Parrot desktop both choose plans through this hook; each words the results itself.
 */
export function usePlanChange(options: UsePlanChangeOptions): UsePlanChangeResult {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [controller] = useState(() =>
    createPlanChangeController({
      api: {
        updateSubscription: (plan, opts) => optionsRef.current.api.updateSubscription(plan, opts),
        startCheckout: (input) => optionsRef.current.api.startCheckout(input),
        completePayment: (paymentId) => optionsRef.current.api.completePayment(paymentId),
      },
      openUrl: (url) => optionsRef.current.openUrl(url),
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
      log: options.log,
    }),
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") controller.checkNow();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [controller]);

  const onPaymentReturn = options.onPaymentReturn;
  useEffect(() => onPaymentReturn?.((paymentId) => controller.paymentReturned(paymentId)), [controller, onPaymentReturn]);

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    state,
    run: controller.run,
    checkNow: controller.checkNow,
    paymentReturned: controller.paymentReturned,
    reopen: controller.reopen,
    stop: controller.stop,
    reset: controller.reset,
  };
}
