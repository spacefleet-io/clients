/**
 * @test-id SHARED-SIGN-UP-001
 * @level unit
 * @why The desktop sign-up checks and API answer sorting live once for Badger and Parrot desktop (ACCT-AUTH-10).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@space/sdk";
import {
  checkSignUpInput,
  classifyResendVerificationError,
  classifySignUpError,
  classifyVerifyEmailError,
  disposableEmailCheck,
} from "../src/signUp";

const say = (line: string, extra?: unknown) => console.info(`[SHARED-SIGN-UP-001] ${line}`, extra ?? "");
const never = () => false;

describe("shared desktop sign-up", () => {
  it("checks password length, a throwaway domain, then the repeated password", () => {
    expect(checkSignUpInput("celeste@example.com", "short", "short", never)).toBe("passwordLength");
    expect(checkSignUpInput("celeste@mailinator.com", "hollow-signal", "x", () => true)).toBe("emailDomainDisallowed");
    expect(checkSignUpInput("celeste@example.com", "hollow-signal", "meltway", never)).toBe("passwordMismatch");
    expect(checkSignUpInput("celeste@example.com", "hollow-signal", "hollow-signal", never)).toBeNull();
  });

  it("reads the build's domain lists; without lists every domain passes and the API decides", () => {
    const check = disposableEmailCheck("good.mailinator.com", "mailinator.com, trash.example");
    say("decisions", { deny: check("a@mailinator.com"), allow: check("a@good.mailinator.com"), other: check("a@example.com") });
    expect(check("a@mailinator.com")).toBe(true);
    expect(check("a@sub.trash.example")).toBe(true);
    expect(check("a@good.mailinator.com")).toBe(false);
    expect(check("a@example.com")).toBe(false);
    expect(disposableEmailCheck(undefined, undefined)("a@mailinator.com")).toBe(false);
  });

  it("sorts the API's answers", () => {
    expect(classifySignUpError(new ApiError(409, { error: "email_exists" }))).toBe("emailExists");
    expect(classifySignUpError(new ApiError(400, { error: "email_domain_disallowed" }))).toBe("emailDomainDisallowed");
    expect(classifySignUpError(new ApiError(429, { error: "rate_limited", retryAfterSeconds: 120 }))).toBe("rateLimited");
    expect(classifySignUpError(new TypeError("fetch failed"))).toBe("generic");
    expect(classifyVerifyEmailError(new ApiError(400, { error: "invalid_code" }))).toBe("invalidCode");
    expect(classifyVerifyEmailError(new ApiError(429, {}))).toBe("rateLimited");
    expect(classifyVerifyEmailError(new ApiError(500, {}))).toBe("generic");
    expect(classifyResendVerificationError(new ApiError(404, { error: "email_not_found" }))).toBe("emailNotFound");
    expect(classifyResendVerificationError(new ApiError(503, {}))).toBe("sendFailed");
  });
});
