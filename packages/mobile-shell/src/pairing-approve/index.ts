// Phone approver of device pairing (ACCT-PAIR-01, ACCT-PAIR-02), shared by Badger and Parrot.
// Pure flow only: the unlock prompt (`./deviceUnlock`, react-native-keychain) and the screen (`./PairDeviceScreen`,
// camera) are their own entry points so a test or a TV build can import the flow without native modules.
export {
  PairingFlowError,
  approvalQuestion,
  approveDevice,
  checkDevice,
  denyDevice,
  deviceTypeLabel,
  lookupDevice,
  pairingErrorMessage,
  readApiError,
  sessionDeviceType,
  type ApprovalProof,
  type PairingDeps,
  type PairingErrorKind,
  type PairingRequestInfo,
} from "./pairingFlow";
export { createPendingPairLink, type PendingPairLink } from "./pairLink";
