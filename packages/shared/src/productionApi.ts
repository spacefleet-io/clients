/**
 * The production API every release build of every app talks to (ACCT-AUTH-09, REL-LAUNCH-03), and a development
 * build's default until a server is picked. One constant for the phone, TV and desktop apps so they cannot drift.
 */
export const PRODUCTION_API_BASE_URL = "https://api.spacefleet.io";
