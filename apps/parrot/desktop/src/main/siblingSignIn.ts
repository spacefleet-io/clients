/**
 * ACCT-PAIR-07: same-device sign-in in Parrot desktop. Signed in, Parrot publishes its account and answers Badger on
 * this computer ("Continue with your Parrot account" in Badger). Signed out, its sign-in screen offers Badger's
 * account. The logic is the shared `@space/desktop-shell/sibling-main`; this file gives it Parrot's store and API.
 * Token and key stay in main, as for "Sign in with another device": the window only learns the key check.
 */
import { hostname } from "node:os";
import { getDesktopPlatform } from "@space/desktop-platform";
import { createDesktopPairingClient, resolveDeviceName } from "@space/desktop-shell/pairing-main";
import { createSiblingHost, resolveSiblingDir, siblingLaunchTarget, type SiblingAccount, type SiblingHost } from "@space/desktop-shell/sibling-main";
import { approvePairingLocal, denyPairing, lookupPairing } from "@space/shared/api";
import { PARROT_SETUP_STEPS, type ParrotSetupStep } from "../shared/ipc";

/** The signed-in account as Parrot's store holds it; null when signed out. The key is read when asked (set later in setup). */
export const parrotSiblingAccount = (store: {
  user: { id: string; email: string } | null;
  token(): string | null;
  libraryKey(): string | null;
}): SiblingAccount | null => {
  const token = store.token();
  const user = store.user;
  if (!token || !user) return null;
  return { token, user: { id: user.id, email: user.email }, libraryKey: async () => store.libraryKey() };
};

/**
 * Signed in through Badger, Parrot already holds the key Badger handed it, so setup goes on past the key step
 * (UX-SETUP-06: "Parrot skips the library key screen too"). The step after it is "profile", which skips itself when
 * not counted. Null: setup is already past the key step and stays where it is.
 */
export const setupStepAfterSiblingSignIn = (current: ParrotSetupStep): ParrotSetupStep | null => {
  const keyIndex = PARROT_SETUP_STEPS.indexOf("libraryKey");
  return PARROT_SETUP_STEPS.indexOf(current) <= keyIndex ? PARROT_SETUP_STEPS[keyIndex + 1]! : null;
};

export const createParrotSiblingHost = (options: {
  getApiBaseUrl: () => string;
  dev: boolean;
  log: (line: string) => void;
  onAnswered?: () => void;
}): SiblingHost => {
  const platform = getDesktopPlatform();
  const log = (message: string, extra?: Record<string, unknown>) => options.log(`[sibling] ${message} ${JSON.stringify(extra ?? {})}`);
  return createSiblingHost({
    app: "parrot",
    place: {
      dir: resolveSiblingDir({ userDataBase: platform.paths.userDataBase, dev: options.dev }),
      ownerOnly: { file: platform.paths.restrictFileToOwner, dir: platform.paths.restrictDirToOwner },
      namedPipe: platform.id === "windows",
    },
    launch: siblingLaunchTarget({ execPath: process.execPath, argv: process.argv, defaultApp: Boolean(process.defaultApp), env: process.env }),
    deviceName: resolveDeviceName(hostname(), platform.id),
    api: { lookup: lookupPairing, approveLocal: approvePairingLocal, deny: denyPairing },
    // Its own pairing client: the "Sign in with another device" screen keeps its own request.
    pairing: createDesktopPairingClient({ getApiBaseUrl: options.getApiBaseUrl, appId: "parrot", platform: platform.id, log }),
    log,
    onAnswered: options.onAnswered,
  });
};
