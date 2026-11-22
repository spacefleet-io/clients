/**
 * `NativeModules.SiblingSignIn` (`@space/mobile-sibling`, ACCT-PAIR-07), typed. The same contract on Android (status
 * provider + approval activity, callers checked by package and signing key) and iOS (team keychain + sibling links).
 * A build without the module (an older native shell, a test) simply has no sister app: no offer, nothing to approve.
 */
import { NativeModules } from "react-native";
import type { SiblingApprovalAnswer } from "./controller";

/** What the sister app lets this app read: the account it is signed in to. */
export type SiblingStatus = { email: string; userId: string };

/** A sign-in request the sister app handed over, waiting for Allow or Cancel here. */
export type IncomingSiblingApproval = { requestId: string; shortCode: string; callerApp: string };

export type IncomingSiblingAnswer =
  | { result: "approved"; sealedKey: string }
  | { result: "cancelled" }
  | { result: "error"; message: string };

type SiblingSignInModule = {
  publishStatus: (status: SiblingStatus | null) => Promise<void>;
  getSiblingStatus: () => Promise<SiblingStatus | null>;
  requestSiblingApproval: (request: { requestId: string; shortCode: string }) => Promise<SiblingApprovalAnswer>;
  getIncomingApproval: () => Promise<IncomingSiblingApproval | null>;
  finishIncomingApproval: (answer: IncomingSiblingAnswer) => Promise<void>;
};

/** Read on use, not at import: a module that imports this (the auth store) loads even where React Native is a stub. */
const module = (): SiblingSignInModule | null => {
  // React Native types `NativeModules` as `any`-like: name the module's shape once here (absent in builds without it).
  const nativeModules: { SiblingSignIn?: SiblingSignInModule } = NativeModules;
  return nativeModules.SiblingSignIn ?? null;
};

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Signed in: `{email, userId}`; signed out: null. Never throws: a failure only means no offer in the sister app. */
export const publishSiblingStatus = async (status: SiblingStatus | null): Promise<void> => {
  try {
    await module()?.publishStatus(status);
  } catch (error) {
    console.warn("[sibling] publishStatus failed", { message: describe(error) });
  }
};

export const getSiblingStatus = async (): Promise<SiblingStatus | null> => {
  try {
    const status = (await module()?.getSiblingStatus()) ?? null;
    return status?.email ? status : null;
  } catch (error) {
    console.warn("[sibling] getSiblingStatus failed", { message: describe(error) });
    return null;
  }
};

export const requestSiblingApproval = async (request: { requestId: string; shortCode: string }): Promise<SiblingApprovalAnswer> => {
  try {
    const native = module();
    if (!native) return { result: "error", message: "no_module" };
    return await native.requestSiblingApproval(request);
  } catch (error) {
    return { result: "error", message: describe(error) };
  }
};

export const getIncomingSiblingApproval = async (): Promise<IncomingSiblingApproval | null> => {
  try {
    return (await module()?.getIncomingApproval()) ?? null;
  } catch (error) {
    console.warn("[sibling] getIncomingApproval failed", { message: describe(error) });
    return null;
  }
};

export const finishIncomingSiblingApproval = async (answer: IncomingSiblingAnswer): Promise<void> => {
  await module()?.finishIncomingApproval(answer);
};
