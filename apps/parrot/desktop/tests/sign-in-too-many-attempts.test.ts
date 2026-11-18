/**
 * ACCT-AUTH-11: when the API refuses a sign-in for now (429 `rate_limited`, OPS-LIMIT-02/03), Parrot desktop's main
 * process hands the renderer `failure: "rateLimited"` plus `retryAfterMinutes`, and the sign-in screen says
 * "Too many attempts. Try again in N minutes." in the app language — singular for one minute, 15 when unknown.
 *
 * @req ACCT-AUTH-11
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@space/shared/api";
import { classifySignInError, retryAfterMinutes } from "@space/shared/signInError";
import { signInFailureText } from "../src/renderer/src/i18n";

const SUITE = "parrot-desktop-too-many-attempts";

describe(`[${SUITE}] sign-in sentence for a 429`, () => {
  it("turns the API refusal into the right sentence in every language", () => {
    const error = new ApiError(429, { error: "rate_limited", retryAfterSeconds: 840 });
    const failure = classifySignInError(error);
    const minutes = retryAfterMinutes(error);
    console.info(`[${SUITE}] failure=${failure} minutes=${minutes}`);
    expect(failure).toBe("rateLimited");
    expect(minutes).toBe(14);

    const cases = [
      ["en", minutes, "Too many attempts. Try again in 14 minutes."],
      ["fr", 1, "Trop de tentatives. Réessayez dans 1 minute."],
      ["en", undefined, "Too many attempts. Try again in 15 minutes."],
    ] as const;
    for (const [language, n, expected] of cases) {
      const text = signInFailureText(language, "rateLimited", n);
      console.info(`[${SUITE}] lang=${language} minutes=${n} text=${JSON.stringify(text)}`);
      expect(text).toBe(expected);
    }
  });

  it("leaves the other sign-in failures alone", () => {
    const text = signInFailureText("en", "credentials", 14);
    console.info(`[${SUITE}] credentials text=${JSON.stringify(text)}`);
    expect(text).not.toContain("Too many attempts");
  });
});
