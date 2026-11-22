/**
 * Same-device sign-in between Badger and Parrot on one phone (ACCT-PAIR-07): the sign-in run, the answer to the
 * sister app's request, and the native channel (`@space/mobile-sibling`). No UI here, so the auth stores can import
 * it: the offer and the question are `@space/mobile-shell/sibling-ui`.
 */
export {
  SIBLING_SIGN_IN_TIMEOUT_MS,
  createSiblingSignInController,
  type SiblingApprovalAnswer,
  type SiblingSignInController,
  type SiblingSignInControllerDeps,
  type SiblingSignInState,
} from "./controller";
export { PHONE_DEVICE_TYPE, answerIncomingSiblingApproval, type SiblingApprovalContext } from "./approval";
export {
  finishIncomingSiblingApproval,
  getIncomingSiblingApproval,
  getSiblingStatus,
  publishSiblingStatus,
  requestSiblingApproval,
  type IncomingSiblingAnswer,
  type IncomingSiblingApproval,
  type SiblingStatus,
} from "./native";
