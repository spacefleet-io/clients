/**
 * NEW-device pairing (ACCT-PAIR-01 / PRIV-KEY-05) shared by every app that signs in by QR + short code
 * (Badger TV, Parrot phone). Pure TS, no react-native import: the React hook is `@space/mobile-shell/pairing-hook`,
 * the QR drawing `@space/mobile-shell/pairing-qr`.
 */
export {
  MAX_POLL_FAILURES,
  MIN_POLL_GAP_MS,
  MIN_RENEW_GAP_MS,
  createPairingController,
  type PairingController,
  type PairingControllerDeps,
  type PairingFailure,
  type PairingState,
} from "./controller";
export { completePairing, type KeyCheck, type PairingCompletion, type PairingCompletionDeps } from "./completion";
export { abortableSleep } from "./sleep";
export {
  createPairingCompletionDeps,
  createPairingKeyCheck,
  type PairingCompletionSetup,
  type PairingRuntimeOptions,
} from "./runtime";
export { QR_QUIET_ZONE, encodeQr, qrPathData, qrViewSize, type QrMatrix } from "./qrMatrix";
export { formatCountdown } from "./countdown";
