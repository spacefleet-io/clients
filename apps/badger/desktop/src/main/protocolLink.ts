/**
 * PLAT-WEB-05: the app's `badger://` link. The web player opens `badger://start` when the runtime is not reachable;
 * the OS starts Badger with the link (or hands it to the running instance). Started through a link, the app starts
 * in the background: the main window is created but never shown, the user stays in the browser.
 *
 * Finding, classifying and registering the link is shared with Parrot (`createAppLinks`, REL-FAM-03); starting in the
 * background through a link is Badger's alone (Parrot has no web player starting it), so it stays here.
 *
 * ACCT-PAY-05 (payment return) and ACCT-SIGNIN-05 (provider sign-in return) links bring the app forward instead.
 *
 * Pure (no Electron import) so every decision is unit-tested.
 */
import { createAppLinks } from "@space/desktop-shell/main-shell";

export const badgerLinks = createAppLinks("badger");

export type LaunchVisibility = "background" | "foreground";

/**
 * How the first window starts. A link at launch (argv, or a macOS `open-url` that arrived before the window
 * existed) → background: created, not shown. A payment or provider return link or anything else → foreground.
 */
export const decideLaunchVisibility = (input: { argv: readonly unknown[]; openUrlBeforeWindow: boolean }): LaunchVisibility => {
  const link = badgerLinks.fromArgv(input.argv);
  return input.openUrlBeforeWindow || link?.kind === "other" ? "background" : "foreground";
};

/**
 * macOS: opening a link can also raise `activate` on the app (first launch or a running app brought forward).
 * Within this window after a link, `activate` must not show the window.
 */
export const LINK_ACTIVATE_GRACE_MS = 3_000;

export const shouldShowOnActivate = (input: { now: number; lastLinkAt: number | null }): boolean =>
  input.lastLinkAt === null || input.now - input.lastLinkAt > LINK_ACTIVATE_GRACE_MS;
