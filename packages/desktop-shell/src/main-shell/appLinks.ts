/**
 * A desktop app's own links (`badger:`, `parrot:`), the same mechanics in both apps (REL-FAM-03):
 * - ACCT-PAY-05: `<scheme>://billing/return?payment=<id>`, the browser coming back from Stancer's payment page.
 * - ACCT-SIGNIN-05: `<scheme>://auth/provider?signinCode=<code>` (or `?signinError=<error>`), the browser coming back
 *   from a Google, Apple or Microsoft sign-in.
 * - any other link of the scheme (Badger's `badger://start`, PLAT-WEB-05), left to the app.
 *
 * How a link arrives, per OS:
 * - Windows / Linux, app not running: in `process.argv` at launch (`Badger.exe badger://start`, dev
 *   `electron <main.js> badger://start`; Chromium may insert switches before it).
 * - Windows / Linux, app running: the second launch's argv, delivered to the first instance by `second-instance`.
 * - macOS: never in argv; `open-url` on the app (register it before `ready` so the launching link is not missed).
 *
 * Pure (no Electron import) so every decision is unit-tested; the app wires the Electron events.
 */
import { parsePaymentReturnLink, type CheckoutReturnApp } from "@space/shared/checkoutReturn";
import { parseProviderReturnLink, type ProviderReturn } from "@space/shared/providerSignIn";
import { protocolClientArgs, type ProtocolClientArgs } from "./protocolClient";

export type AppLink =
  | { kind: "provider-return"; link: string; outcome: ProviderReturn }
  | { kind: "payment-return"; link: string; paymentId: string }
  | { kind: "other"; link: string };

/** The part of Electron's `app` the registration needs. */
export type ProtocolClientApp = {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
};

export type AppLinkRegistration =
  | { registered: boolean; args: ProtocolClientArgs }
  /** Tests (SF_E2E=1) never rewrite the machine's handler: they hand the link over in a second launch's argv. */
  | { skipped: "e2e" }
  /** A launch that lost the single-instance lock hands over to the running app, which already holds the link. */
  | { skipped: "not-primary" };

export type AppLinks = {
  scheme: CheckoutReturnApp;
  /** The first link of the scheme in a command line, or null. Case-insensitive; surrounding quotes (Windows shells) dropped. */
  find(argv: readonly unknown[]): string | null;
  /** What a link of the scheme is: a provider sign-in return, a payment return, or anything else. */
  classify(link: string): AppLink;
  /** The link a command line carries (a launch's or a second launch's argv), classified, or null without one. */
  fromArgv(argv: readonly unknown[]): AppLink | null;
  /**
   * Makes the app the OS's handler of the scheme. A dev run (`process.defaultApp`) registers the Electron binary plus
   * its main script, else the OS would start a bare Electron; a dev run whose argv[1] is itself a link registers the
   * app itself (`protocolClientArgs`).
   */
  register(input: {
    app: ProtocolClientApp;
    primary: boolean;
    env: NodeJS.ProcessEnv;
    defaultApp: boolean;
    execPath: string;
    argv: readonly string[];
    resolvePath: (path: string) => string;
  }): AppLinkRegistration;
};

export const createAppLinks = (scheme: CheckoutReturnApp): AppLinks => {
  const prefix = `${scheme}:`;

  const find = (argv: readonly unknown[]): string | null => {
    for (const raw of argv) {
      if (typeof raw !== "string") continue;
      const arg = raw.trim().replace(/^"(.*)"$/u, "$1");
      if (arg.toLowerCase().startsWith(prefix)) return arg;
    }
    return null;
  };

  const classify = (link: string): AppLink => {
    const outcome = parseProviderReturnLink(scheme, link);
    if (outcome !== null) return { kind: "provider-return", link, outcome };
    const paymentId = parsePaymentReturnLink(scheme, link);
    if (paymentId !== null) return { kind: "payment-return", link, paymentId };
    return { kind: "other", link };
  };

  const fromArgv = (argv: readonly unknown[]): AppLink | null => {
    const link = find(argv);
    return link === null ? null : classify(link);
  };

  const register: AppLinks["register"] = (input) => {
    if (input.env.SF_E2E === "1") return { skipped: "e2e" };
    if (!input.primary) return { skipped: "not-primary" };
    const args = protocolClientArgs(scheme, input);
    const registered = args.length === 3 ? input.app.setAsDefaultProtocolClient(args[0], args[1], args[2]) : input.app.setAsDefaultProtocolClient(args[0]);
    return { registered, args };
  };

  return { scheme, find, classify, fromArgv, register };
};

/** A link for a log line: its kind and outcome, never the sign-in code itself. */
export const describeAppLink = (link: AppLink): string => {
  if (link.kind === "provider-return") return `provider-return ${"code" in link.outcome ? "code" : link.outcome.error}`;
  if (link.kind === "payment-return") return `payment-return ${link.paymentId}`;
  return "other";
};
