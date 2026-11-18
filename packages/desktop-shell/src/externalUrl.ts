/**
 * Shared by every Electron app's main process (Badger and Parrot desktop; REL-FAM-02).
 * What the main process hands to the operating system (`shell.openExternal`): only `https:` web
 * pages and `mailto:` links. Anything else (`file:`, `javascript:`, custom app schemes, plain
 * `http:`) could run or open something on the user's machine, so it is never opened, whoever asked.
 *
 * One exception, REL-ENV-39: an app whose own API is a plain `http:` address on this computer (a dev stack) may open
 * plain `http:` addresses on this computer, the stand-in of the Google, Apple and Microsoft sign-in pages. A release
 * package talks to the production API over https, so it never opens one.
 */
const ALLOWED_EXTERNAL_PROTOCOLS: Record<string, true> = { "https:": true, "mailto:": true };

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

const isLoopbackHttp = (url: URL) => url.protocol === "http:" && Object.hasOwn(LOOPBACK_HOSTS, url.hostname);

/** `apiBaseUrl`: the API this app talks to; a loopback `http:` one lets loopback `http:` addresses open too. */
export const isAllowedExternalUrl = (url: string, apiBaseUrl?: string): boolean => {
  try {
    const parsed = new URL(url);
    if (ALLOWED_EXTERNAL_PROTOCOLS[parsed.protocol] === true) return true;
    return apiBaseUrl !== undefined && isLoopbackHttp(parsed) && isLoopbackHttp(new URL(apiBaseUrl));
  } catch {
    return false;
  }
};
