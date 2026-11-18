/**
 * @level unit
 * ACCT-PAY-05: the link a desktop app accepts back from Stancer's payment page. The website builds
 * `<app>://billing/return?payment=<id>`; each app accepts only its own scheme, that host and path, and a UUID id.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_RETURN_APPS,
  findPaymentReturn,
  isCheckoutReturnApp,
  isPaymentId,
  parsePaymentReturnLink,
  paymentReturnLink,
} from "../src/checkoutReturn";

const SUITE = "checkout-return";
const PAY = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe(`[${SUITE}] return link`, () => {
  // @req ACCT-PAY-05
  it("round-trips the link for each desktop app, as the OS hands it over", () => {
    for (const app of CHECKOUT_RETURN_APPS) {
      const link = paymentReturnLink(app, PAY);
      console.info(`[${SUITE}] built`, { app, link });
      expect(link).toBe(`${app}://billing/return?payment=${PAY}`);
      expect(parsePaymentReturnLink(app, link)).toBe(PAY);
      expect(parsePaymentReturnLink(app, `"${link}"`)).toBe(PAY);
      expect(parsePaymentReturnLink(app, `${app}://billing/return/?payment=${PAY}`)).toBe(PAY);
      expect(parsePaymentReturnLink(app, `${app.toUpperCase()}://BILLING/return?payment=${PAY}`)).toBe(PAY);
    }
  });

  // @req ACCT-PAY-05
  it("refuses the other app's link, other hosts, paths, ids and anything that is not a link", () => {
    for (const value of [
      `badger://billing/return?payment=${PAY}`,
      `parrot://start`,
      `parrot://evil/return?payment=${PAY}`,
      `parrot://billing/other?payment=${PAY}`,
      `parrot://billing/return`,
      `parrot://billing/return?payment=pay_1`,
      `parrot://billing/return?payment=${PAY}x`,
      `https://spacefleet.io/en/payment-return?payment=${PAY}`,
      `parrot://billing/return?payment=${PAY}&pad=${"a".repeat(200)}`,
      "parrot:%%%",
      "",
      42,
      null,
    ]) {
      const got = parsePaymentReturnLink("parrot", value);
      console.info(`[${SUITE}] refuse`, { value: String(value).slice(0, 60), got });
      expect(got).toBeNull();
    }
  });

  // @req ACCT-PAY-05
  it("finds the link in a second launch's command line, after Chromium switches", () => {
    const argv = ["/opt/Parrot/parrot", "--allow-file-access-from-files", "--no-sandbox", `parrot://billing/return?payment=${PAY}`];
    expect(findPaymentReturn("parrot", argv)).toBe(PAY);
    expect(findPaymentReturn("parrot", ["/opt/Parrot/parrot"])).toBeNull();
    expect(findPaymentReturn("badger", argv)).toBeNull();
  });

  // @req ACCT-PAY-05
  it("knows only the two desktop apps and UUID payment ids", () => {
    expect(CHECKOUT_RETURN_APPS).toEqual(["badger", "parrot"]);
    expect(isCheckoutReturnApp("parrot")).toBe(true);
    expect(isCheckoutReturnApp("tv")).toBe(false);
    expect(isCheckoutReturnApp("phone")).toBe(false);
    expect(isPaymentId(PAY)).toBe(true);
    expect(isPaymentId("../evil")).toBe(false);
  });
});
