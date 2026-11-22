import { CLIENT_IDENTITY_ENV, parseClientHeader, setClientIdentity, type ClientIdentity } from "@space/shared/appVersion";

/**
 * REL-CD-29, REL-LOG-28: the runtime's API calls (library saves, uploads) state the build of the desktop app that
 * started it, which hands it over in {@link CLIENT_IDENTITY_ENV}. A runtime started without it (a dev or headless
 * run) states nothing, as before.
 */
export const applyClientIdentityFromEnv = (env: Readonly<Record<string, string | undefined>>): ClientIdentity | null => {
  const identity = parseClientHeader(env[CLIENT_IDENTITY_ENV]);
  setClientIdentity(identity);
  return identity;
};
