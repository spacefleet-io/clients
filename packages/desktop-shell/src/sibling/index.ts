/**
 * ACCT-PAIR-07: same-device sign-in between Badger desktop and Parrot desktop, main process only (`./sibling-main`).
 * Window-safe types are `./sibling`.
 */
export { askSibling, startSiblingServer } from "./channel";
export type { SiblingAnswer, SiblingAskInput, SiblingOp, SiblingServer, SiblingServerOptions } from "./channel";
export { armSiblingHiddenQuit } from "./hidden";
export type { SiblingHiddenQuit } from "./hidden";
export { createSiblingHost } from "./host";
export type { SiblingAccount, SiblingHost, SiblingHostOptions } from "./host";
export {
  SIBLING_SIGN_IN_ARG,
  isSiblingSignInLaunch,
  posixOwnerOnly,
  resolveSiblingDir,
  siblingLaunchTarget,
  siblingSocketPath,
} from "./place";
export type { SiblingOwnerOnly, SiblingPlace } from "./place";
export { ensureSiblingSecret } from "./secret";
export { SIBLING_SIGN_IN_TIMEOUT_MS, createSiblingSignIn } from "./signIn";
export type { SiblingPairing, SiblingSignIn, SiblingSignInOptions } from "./signIn";
export { readSiblingOffer, readSiblingStatus, removeSiblingStatus, writeSiblingStatus } from "./status";
export type { SiblingStatus, SiblingStatusInput } from "./status";
export type { SiblingOffer, SiblingSignInActions, SiblingSignInResult } from "./types";
