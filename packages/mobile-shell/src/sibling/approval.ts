/**
 * Same-device sign-in, the SIGNED-IN phone app (ACCT-PAIR-07): the sister app's request arrived over the local
 * channel (the OS checked the caller), and the user tapped Allow or Cancel on "Let {App} use your SpaceFleet account?".
 * Allow approves only the sister app's own phone sign-in (`approveSiblingRequest` checks the request) and hands the
 * sealed key back over the same channel; the API is told only to approve. Every path answers, so the sister never hangs.
 */
import {
  approvePairingErrorKind,
  approveSiblingRequest,
  refuseSiblingRequest,
  siblingAppOf,
  type SiblingApproveDeps,
} from "@space/pairing-crypto";
import type { IncomingSiblingAnswer, IncomingSiblingApproval } from "./native";

/** Phones announce themselves as `mobile` when they ask to sign in (Badger and Parrot phone pairing clients). */
export const PHONE_DEVICE_TYPE = "mobile";

export type SiblingApprovalContext = {
  self: "badger" | "parrot";
  /** This app's session; null when it is signed out (nothing to approve with). */
  token: string | null;
  deps: SiblingApproveDeps;
  incoming: IncomingSiblingApproval;
  finish: (answer: IncomingSiblingAnswer) => Promise<void>;
};

export const answerIncomingSiblingApproval = async (ctx: SiblingApprovalContext, allow: boolean): Promise<IncomingSiblingAnswer> => {
  const asker = siblingAppOf(ctx.self);
  let answer: IncomingSiblingAnswer;
  if (!ctx.token || !asker) {
    answer = { result: "error", message: "not_signed_in" };
  } else if (allow) {
    try {
      const { sealedKey } = await approveSiblingRequest(ctx.deps, ctx.token, ctx.incoming.shortCode, { asker, deviceType: PHONE_DEVICE_TYPE });
      answer = { result: "approved", sealedKey: JSON.stringify(sealedKey) };
    } catch (error) {
      answer = { result: "error", message: approvePairingErrorKind(error) };
    }
  } else {
    try {
      await refuseSiblingRequest(ctx.deps, ctx.token, ctx.incoming.shortCode, { asker, deviceType: PHONE_DEVICE_TYPE });
    } catch (error) {
      // The user said no: the sister app goes back to its sign-in either way; its request simply expires.
      console.warn("[sibling] refuse failed", { message: error instanceof Error ? error.message : String(error) });
    }
    answer = { result: "cancelled" };
  }
  console.info("[sibling] approval.answer", { result: answer.result, requestId: ctx.incoming.requestId });
  await ctx.finish(answer);
  return answer;
};
