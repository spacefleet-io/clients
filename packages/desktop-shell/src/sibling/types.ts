/**
 * ACCT-PAIR-07: shapes crossing the main <-> window boundary for "Continue with your Badger account" (and its Parrot
 * twin), shared by Badger desktop and Parrot desktop. Window-safe: no Node import.
 */
import type { SpaceAppId } from "@space/shared/appScope";
import type { PairingHandOver } from "../pairing/types";

/** The sister app's account on this computer: the only things the window is told. */
export type SiblingOffer = { app: SpaceAppId; email: string };

/**
 * How one same-device sign-in ended. `A` is what an approval carries to the window, as for the pairing screen: Badger's
 * window stores the session itself and gets the hand-over; Parrot keeps the token and key in main and only tells the
 * window whether the key opened the library.
 */
export type SiblingSignInResult<A = PairingHandOver> = ({ status: "approved" } & A) | { status: "cancelled" } | { status: "failed" };

/** The window's bridge (preload). */
export type SiblingSignInActions<A = PairingHandOver> = {
  offer: () => Promise<SiblingOffer | null>;
  signIn: () => Promise<SiblingSignInResult<A>>;
  cancel: () => Promise<void>;
};

/** The card's IPC channels, the same in both apps. */
export const SIBLING_IPC = { offer: "sf-sibling-offer", signIn: "sf-sibling-sign-in", cancel: "sf-sibling-cancel" } as const;
