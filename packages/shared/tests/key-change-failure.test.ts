/**
 * @test-id SHARED-KEY-CHANGE-FAILURE-001
 * @level unit
 * @req ACCT-KEYCHG-03[badger-desktop,parrot]
 * @why Parrot desktop changes the media library key in its main process and Badger desktop in its renderer; both say
 *   why a key change stopped with the same sentences in five languages (REL-FAM-02), naming the other app whose library
 *   is re-encrypted alongside (PRIV-KEY-06).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { keyChangeFailureOf, keyChangeFailureText, keyChangeRefusalText } from "../src/keyChangeFailure";

describe("keyChangeFailureOf", () => {
  it("maps every refusal the API and the re-encryption give", () => {
    const cases: Array<[unknown, string]> = [
      [new ApiError(401, { error: "invalid_password" }), "invalidPassword"],
      [new ApiError(401, { error: "two_factor_invalid" }), "invalidCode"],
      [new ApiError(409, { error: "version_conflict" }), "changed"],
      [new ApiError(409, { error: "media_reseal_incomplete", pendingFiles: 2 }), "resealIncomplete"],
      [new ApiError(409, { error: "reseal_run_not_open" }), "resealStopped"],
      [new ApiError(409, { error: "library_not_reencrypted" }), "notReencrypted"],
      [new ApiError(409, { error: "rotation_needs_media_reseal" }), "other"],
      [new Error("ROTATION_REENCRYPT_UNREADABLE"), "unreadable"],
      [new Error("ROTATION_REENCRYPT_NOT_SNAPSHOTTED"), "notSnapshotted"],
      [new Error("ROTATION_REENCRYPT_FAILED"), "reencryptFailed"],
      [new Error("boom"), "other"],
      ["boom", "other"],
    ];
    for (const [err, reason] of cases) expect(keyChangeFailureOf(err)).toEqual({ status: "failed", reason });
  });

  it("asks for the code, by the method the account uses", () => {
    expect(keyChangeFailureOf(new ApiError(401, { error: "two_factor_required", method: "totp" }))).toEqual({
      status: "codeNeeded",
      method: "totp",
    });
    expect(keyChangeFailureOf(new ApiError(401, { error: "two_factor_required" }))).toEqual({ status: "codeNeeded", method: "email" });
  });

  it("says when to try again after too many attempts", () => {
    const failure = keyChangeFailureOf(new ApiError(429, { error: "rate_limited", retryAfterSeconds: 125 }));
    expect(failure).toEqual({ status: "failed", reason: "tooManyAttempts", minutes: 3 });
  });

  it("survives a JSON round trip (Electron IPC)", () => {
    const failure = keyChangeFailureOf(new ApiError(409, { error: "version_conflict" }));
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
  });
});

describe("keyChangeFailureText", () => {
  it("names the other app in every language", () => {
    expect(keyChangeFailureText("en", { status: "failed", reason: "unreadable" }, "Badger")).toBe(
      "Your current key does not open your Badger library, so nothing changed."
    );
    expect(keyChangeFailureText("de", { status: "failed", reason: "notSnapshotted" }, "Parrot")).toContain("Öffne Parrot,");
    for (const language of ["en", "fr", "de", "es", "nl"] as const) {
      expect(keyChangeFailureText(language, { status: "failed", reason: "reencryptFailed" }, "Badger")).toContain("Badger");
      expect(keyChangeFailureText(language, { status: "failed", reason: "other" }, "Badger")).not.toContain("{");
    }
  });

  it("uses the sign-in sentence for too many attempts", () => {
    expect(keyChangeFailureText("en", { status: "failed", reason: "tooManyAttempts", minutes: 1 }, "Parrot")).toMatch(/1 minute\b/);
  });
});

describe("keyChangeRefusalText", () => {
  it("words only the refusals that changed nothing", () => {
    expect(keyChangeRefusalText("en", new ApiError(409, { error: "version_conflict" }), "Parrot")).toBe(
      "Your library changed while the key was being replaced. Nothing changed. Please try again."
    );
    expect(keyChangeRefusalText("en", new ApiError(401, { error: "invalid_password" }), "Parrot")).toBeNull();
    expect(keyChangeRefusalText("en", new ApiError(429, { error: "rate_limited" }), "Parrot")).toBeNull();
    expect(keyChangeRefusalText("en", new Error("boom"), "Parrot")).toBeNull();
  });
});
