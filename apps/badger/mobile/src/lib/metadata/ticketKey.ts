import { ticketKeysForBuild, type PinnedTicketKey } from "@space/privacy-pass";
import { isMobileDevBuild, type MobileBuildEnv } from "../devBuild";

/**
 * The ticket keys this app trusts (META-ANON-03, META-ANON-06, META-ANON-07), phone and TV alike: in a dev build
 * (`__DEV__`, or a `profile` build made for dev-stack testing with `SF_DEV_TICKET_KEY=1`) the key of every environment,
 * dev and production, so the server picker (ACCT-AUTH-09) can point at any API; in every other build the production
 * key only. Decided by the build, never by the API host the app is signed in to.
 */
export const mobileTicketKeys = (env: MobileBuildEnv): readonly PinnedTicketKey[] => ticketKeysForBuild(isMobileDevBuild(env));
