/**
 * What the build decided, all inlined at build time: Metro's `__DEV__`, `SF_DEV_TICKET_KEY`, `SF_DEV_API_BASE_URL`
 * (babel-plugin-dev-ticket-key.js; the second only ever set next to `SF_DEV_TICKET_KEY=1`) and `SF_SIMULATOR_BUILD`
 * ("1" in a bundle Xcode built for the iOS or tvOS simulator, "" everywhere else; REL-TEST-36's lane override).
 */
export type MobileBuildEnv = {
  dev: boolean;
  devTicketKeyFlag: string | undefined;
  devApiBaseUrl?: string | undefined;
  simulatorBuild?: string | undefined;
};

/**
 * Whether this is a development build, phone and TV alike: `__DEV__`, or a `profile` build made for dev-stack testing
 * with `SF_DEV_TICKET_KEY=1` (refused for any release build). It decides both the ticket keys the app trusts
 * (META-ANON-06, META-ANON-07) and whether it has the server picker (ACCT-AUTH-09). Decided by the build, never by the
 * API host the app talks to.
 */
export const isMobileDevBuild = (env: MobileBuildEnv): boolean => env.dev === true || env.devTicketKeyFlag === "1";

/** The flags of the running bundle. The `process.env.…` reads must stay spelled out: babel inlines them here. */
export const currentMobileBuildEnv = (): MobileBuildEnv => ({
  dev: __DEV__,
  devTicketKeyFlag: process.env.SF_DEV_TICKET_KEY,
  devApiBaseUrl: process.env.SF_DEV_API_BASE_URL,
  simulatorBuild: process.env.SF_SIMULATOR_BUILD,
});
