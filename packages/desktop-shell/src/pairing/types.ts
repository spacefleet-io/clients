/**
 * ACCT-PAIR-01: shapes crossing the main <-> renderer boundary for the "Sign in with your phone" screen, shared by
 * Badger desktop and Parrot desktop (REL-FAM-02).
 */

/**
 * `sign_in`: a signed-out computer asks for a session and the library key (the sign-in screen). `key`: the computer is
 * already signed in and asks only for the library key (the key screen); the request carries its own session.
 */
export type PairingMode = "sign_in" | "key";

export type PairingStartOptions = { mode?: PairingMode };

/** The start IPC's argument as the main process receives it: anything but `{ mode: "key" }` is a sign-in. */
export const pairingModeOf = (raw: unknown): PairingMode =>
  typeof raw === "object" && raw !== null && (raw as PairingStartOptions).mode === "key" ? "key" : "sign_in";

export type PairingStart = {
  requestId: string;
  /** The 8 plain characters, e.g. "ABCDEFGH", shown as two groups of 4, never with a dash (ACCT-PAIR-01). */
  shortCode: string;
  qrPayload: string;
  /** Inline SVG of the QR code (black on white, with the quiet zone scanners need). */
  qrSvg: string;
  expiresAt: string;
  deviceName: string;
};

export type PairingUser = { id: string; email: string; [key: string]: unknown };

/** What the phone hands over on approval, as the main process received it. */
export type PairingHandOver = { token: string; user: PairingUser; libraryKey: string };

/**
 * One poll's answer. `A` is what an approval carries to the window: Badger's window stores the session itself and gets
 * the hand-over; Parrot keeps the token and key in main and only tells the window whether the key opened the library.
 */
export type PairingPoll<A = PairingHandOver> =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | ({ status: "approved" } & A)
  /** The phone approved but the sealed key could not be opened with this device's key. */
  | { status: "key_unreadable" };

export type PairingFailure = "rate_limited" | "unreachable" | "failed";
/** Why a pairing call failed; `retryAfterMinutes` (whole minutes, at least 1) comes with `rate_limited` (ACCT-AUTH-11). */
export type PairingRefusal = { error: PairingFailure; retryAfterMinutes?: number };
export type PairingStartResult = ({ ok: true } & PairingStart) | ({ ok: false } & PairingRefusal);
export type PairingPollResult<A = PairingHandOver> = ({ ok: true } & PairingPoll<A>) | ({ ok: false } & PairingRefusal);

/** Whether the library key from the phone opens this account's library. Nothing is stored on "mismatch". */
export type PairedKeyCheck = "verified" | "mismatch";
