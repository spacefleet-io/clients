/**
 * Back to the app that started a payment (ACCT-PAY-05). A desktop app opens Stancer's hosted payment page in the
 * system browser; Stancer only sends the browser to an https address, so the API points the return at the website's
 * hand-off page (`/<lang>/payment-return?billing=return&payment=<id>&app=<app>`), which opens the app's own link
 * (`parrot://billing/return?payment=<id>`, `badger://…`). The OS hands that link to the running app (Windows / Linux:
 * a second launch's argv, delivered by `second-instance`; macOS: `open-url`), which completes the payment at once.
 *
 * One module for the API (which app may be named), the website (which link to open) and both desktop apps (which
 * link to accept), so the three never disagree. Only these apps, only this link shape, only a plain payment id:
 * nothing a request names can make the website open any other address.
 */

/** The apps a checkout can return to besides the website. The phone and TV apps never pay (ACCT-PAY-02). */
export const CHECKOUT_RETURN_APPS = ["badger", "parrot"] as const;
export type CheckoutReturnApp = (typeof CHECKOUT_RETURN_APPS)[number];

export const isCheckoutReturnApp = (value: unknown): value is CheckoutReturnApp =>
  typeof value === "string" && (CHECKOUT_RETURN_APPS as readonly string[]).includes(value);

/** The website page (under `/<lang>/`) that hands a desktop checkout back to its app. */
export const PAYMENT_RETURN_PAGE = "payment-return";

/** Our payment ids are UUIDs; anything else in a return link is refused. */
const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isPaymentId = (value: unknown): value is string => typeof value === "string" && PAYMENT_ID.test(value);

/** The app's link for a finished payment: `parrot://billing/return?payment=<id>`. */
export const paymentReturnLink = (app: CheckoutReturnApp, paymentId: string): string =>
  `${app}://billing/return?payment=${encodeURIComponent(paymentId)}`;

/** The payment id of a return link for `app`, or null when the value is anything else. */
export const parsePaymentReturnLink = (app: CheckoutReturnApp, value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^"(.*)"$/, "$1");
  if (raw.length > 200 || !raw.toLowerCase().startsWith(`${app}:`)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${app}:` || url.hostname.toLowerCase() !== "billing" || url.pathname.replace(/\/+$/, "") !== "/return") return null;
  const paymentId = url.searchParams.get("payment");
  return isPaymentId(paymentId) ? paymentId : null;
};

/** The payment id of the first return link for `app` in a command line (a second launch's argv), or null. */
export const findPaymentReturn = (app: CheckoutReturnApp, argv: readonly unknown[]): string | null => {
  for (const arg of argv) {
    const paymentId = parsePaymentReturnLink(app, arg);
    if (paymentId !== null) return paymentId;
  }
  return null;
};
