/**
 * @test-id PARROT-MOBILE-LIBRARY-OPEN-001
 * @level unit
 * @bugfix @regression-proof
 *
 * A saved session the server rejects (401/403) used to leave the library on "Couldn't open your library
 * (unauthorized)" with a Try again that could never work; the only way out was Settings → Sign out. Now a rejected
 * session sends the user back to sign-in with a short explanation, and only a rejection does: no network, a timeout
 * or a server error keeps the session so the library opens again later.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@space/shared/api";
import { libraryOpenOutcome } from "../src/lib/libraryOpen";

describe("libraryOpenOutcome", () => {
  it("sends a rejected session back to sign-in", () => {
    for (const status of [401, 403]) {
      const outcome = libraryOpenOutcome(new ApiError(status, { error: "unauthorized" }));
      console.info("library open outcome", { status, outcome });
      expect(outcome).toBe("sessionRejected");
    }
  });

  it("keeps the session on any other failure", () => {
    expect(libraryOpenOutcome(new ApiError(500, { error: "boom" }))).toBe("error");
    expect(libraryOpenOutcome(new TypeError("Network request failed"))).toBe("error");
    expect(libraryOpenOutcome(new Error("DECRYPT_FAILED"))).toBe("error");
  });

  it("tells an account without a Parrot library apart", () => {
    expect(libraryOpenOutcome(new Error("LIBRARY_MISSING"))).toBe("missing");
  });
});
