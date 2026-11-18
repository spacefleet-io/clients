// A tester's message to the team, through the API's shared feedback endpoint (`POST /feedback`, SDK `sendFeedback`):
// the same route every SpaceFleet app uses, tagged `parrot-mobile`. The form, the body and the error log (attached
// only when the user ticked the box, scrubbed as it was recorded: UX-SUP-02, UX-SUP-05) are the phone apps' shared
// basis (`@space/mobile-shell`), exactly as in Badger (REL-FAM-03).
import * as sdk from "@space/sdk";
import type { FeedbackInput } from "@space/shared/api";
import { phoneFeedbackDevice } from "@space/mobile-shell/feedback-device";
import packageJson from "../../package.json";
import { API_BASE_URL } from "../config";

/** What the message says about this install: the app, its version and the kind of phone. */
export const parrotFeedbackDevice = () => phoneFeedbackDevice("parrot-mobile", packageJson.version);

/** Sends the body as the signed-in account. Throws `ApiError` on refusal (e.g. 429). */
export const sendParrotFeedback = async (token: string, body: FeedbackInput): Promise<void> => {
  await sdk.unwrap(sdk.sendFeedback({ client: sdk.createSpaceClient({ baseUrl: API_BASE_URL, token, appId: "parrot" }), body }));
};
