import { describe, expect, it } from "vitest";
import { validateDesktopSignupInput } from "@/lib/signupValidation";

describe("desktop signup validation", () => {
  it("rejects short passwords", () => {
    expect(validateDesktopSignupInput("user@example.com", "short", "short")).toBe("signup.errors.passwordLength");
  });

  it("rejects disposable domains before submit", () => {
    expect(validateDesktopSignupInput("user@mailinator.com", "password123", "password123", () => true))
      .toBe("signup.errors.emailDomainDisallowed");
  });

  it("rejects password mismatch", () => {
    expect(validateDesktopSignupInput("user@example.com", "password123", "password124", () => false))
      .toBe("signup.errors.passwordMismatch");
  });

  it("accepts valid input", () => {
    expect(validateDesktopSignupInput("user@example.com", "password123", "password123", () => false)).toBeNull();
  });
});

