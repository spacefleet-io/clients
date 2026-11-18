/**
 * @test-id DESKTOP-ARTWORK-SESSION-GUARD
 * @level unit
 * @req META-ART-01[badger-desktop]
 * @why The decrypted-artwork cache is cleared on sign-out. A display that started before sign-out and finishes
 *      after must not write the user's decrypted artwork back to disk; a new sign-in opens writes again.
 */
import { describe, expect, test } from "vitest";
import { closeArtworkSession, currentArtworkSession, mayWriteArtwork, openArtworkSession } from "../src/renderer/src/lib/artworkCache";

const phase = (name: string, extra?: string) => console.info(`[artwork-session:${name}]${extra ? ` ${extra}` : ""}`);

describe("artwork cache sign-out guard", () => {
  test("a load started before sign-out may not write after it; one started after the next sign-in may", () => {
    openArtworkSession();
    const before = currentArtworkSession();
    phase("signed-in", `session=${before}`);
    expect(mayWriteArtwork(before)).toBe(true);

    closeArtworkSession();
    phase("signed-out", `session=${currentArtworkSession()}`);
    expect(mayWriteArtwork(before)).toBe(false);
    // Started while signed out (token not dropped yet): still no write.
    expect(mayWriteArtwork(currentArtworkSession())).toBe(false);

    openArtworkSession();
    const after = currentArtworkSession();
    phase("signed-in-again", `session=${after}`);
    expect(mayWriteArtwork(before)).toBe(false);
    expect(mayWriteArtwork(after)).toBe(true);
  });
});
