/**
 * PLAT-WEB-05: the app's `badger://` link. The web player opens `badger://start` when the runtime is not reachable;
 * the OS starts Badger with the link (or hands it to the running instance). Started through a link, the app starts
 * in the background: the main window is created but never shown, the user stays in the browser.
 *
 * How the link arrives, per OS:
 * - Windows / Linux, app not running: in `process.argv` at launch (`Badger.exe badger://start`,
 *   `spacebadger badger://start`, dev `electron <main.js> badger://start`; Chromium may insert switches before it).
 * - Windows / Linux, app running: the second launch's argv, delivered to the first instance by `second-instance`.
 * - macOS: never in argv; `open-url` on the app (registered before `ready` so the launching link is not missed).
 *
 * ACCT-PAY-05: `badger://billing/return?payment=<id>` is the other link: the browser coming back from Stancer's payment
 * page (through the website's hand-off page). That one brings the app forward instead (`paymentReturnOf`).
 *
 * ACCT-SIGNIN-05: `badger://auth/provider?signinCode=<code>` (or `?signinError=<error>`) is the browser coming back from
 * a Google, Apple or Microsoft sign-in the sign-in screen started. It brings the app forward too (`providerReturnOf`).
 *
 * Pure (no Electron import) so every decision is unit-tested.
 */
import { parsePaymentReturnLink } from "@space/shared/checkoutReturn";
import { parseProviderReturnLink, type ProviderReturn } from "@space/shared/providerSignIn";

export const BADGER_PROTOCOL_SCHEME = "badger";

const LINK_PREFIX = `${BADGER_PROTOCOL_SCHEME}:`;

/** `badger:` link in a command line, or null. Case-insensitive scheme; surrounding quotes (Windows shells) dropped. */
export const findBadgerLink = (argv: readonly unknown[]): string | null => {
  for (const raw of argv) {
    if (typeof raw !== "string") continue;
    const arg = raw.trim().replace(/^"(.*)"$/, "$1");
    if (arg.toLowerCase().startsWith(LINK_PREFIX)) return arg;
  }
  return null;
};

export const isBadgerLink = (value: unknown): value is string =>
  typeof value === "string" && value.trim().toLowerCase().startsWith(LINK_PREFIX);

export type LaunchVisibility = "background" | "foreground";

/** The payment id of a `badger://billing/return` link, or null for any other link. */
export const paymentReturnOf = (link: string): string | null => parsePaymentReturnLink(BADGER_PROTOCOL_SCHEME, link);

/** The outcome of a `badger://auth/provider` link (code or error), or null for any other link. */
export const providerReturnOf = (link: string): ProviderReturn | null => parseProviderReturnLink(BADGER_PROTOCOL_SCHEME, link);

/** A link that brings the app forward (a payment or a provider sign-in coming back) rather than keeping it hidden. */
const bringsAppForward = (link: string): boolean => paymentReturnOf(link) !== null || providerReturnOf(link) !== null;

/**
 * How the first window starts. A link at launch (argv, or a macOS `open-url` that arrived before the window
 * existed) → background: created, not shown. A payment or provider return link or anything else → foreground.
 */
export const decideLaunchVisibility = (input: { argv: readonly unknown[]; openUrlBeforeWindow: boolean }): LaunchVisibility => {
  const link = findBadgerLink(input.argv);
  return input.openUrlBeforeWindow || (link !== null && !bringsAppForward(link)) ? "background" : "foreground";
};

/**
 * Arguments for `app.setAsDefaultProtocolClient`. A packaged app registers itself. A dev run (`process.defaultApp`:
 * `electron <main.js>`) must register the Electron binary plus the absolute path of its main script, else the OS
 * would start a bare Electron.
 */
export const protocolClientArgs = (input: {
  defaultApp: boolean;
  execPath: string;
  argv: readonly string[];
  resolvePath: (path: string) => string;
}): [scheme: string] | [scheme: string, path: string, args: string[]] => {
  const script = input.argv[1];
  if (input.defaultApp && typeof script === "string" && script.length > 0 && !isBadgerLink(script)) {
    return [BADGER_PROTOCOL_SCHEME, input.execPath, [input.resolvePath(script)]];
  }
  return [BADGER_PROTOCOL_SCHEME];
};

/**
 * macOS: opening a link can also raise `activate` on the app (first launch or a running app brought forward).
 * Within this window after a link, `activate` must not show the window.
 */
export const LINK_ACTIVATE_GRACE_MS = 3_000;

export const shouldShowOnActivate = (input: { now: number; lastLinkAt: number | null }): boolean =>
  input.lastLinkAt === null || input.now - input.lastLinkAt > LINK_ACTIVATE_GRACE_MS;
