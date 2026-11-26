/**
 * ACCT-PAIR-07: same-device sign-in in Badger desktop. Signed in, Badger publishes its account and answers Parrot on
 * this computer ("Continue with your Badger account" in Parrot). Signed out, its sign-in screen offers Parrot's
 * account. The logic is the shared `@space/desktop-shell/sibling-main`; this file gives it Badger's session, API and
 * IPC.
 */
import { hostname as osHostname } from "node:os";
import { ipcMain } from "electron";
import { getDesktopPlatform } from "@space/desktop-platform";
import { createDesktopPairingClient, resolveDeviceName } from "@space/desktop-shell/pairing-main";
import { createSiblingHost, resolveSiblingDir, siblingLaunchTarget, type SiblingAccount, type SiblingHost } from "@space/desktop-shell/sibling-main";
import { SIBLING_IPC, type SiblingOffer, type SiblingSignInResult } from "@space/desktop-shell/sibling";
import { currentDesktopBuildEnv, isDesktopDevBuild } from "../shared/devBuild";
import { AUTH_TOKEN_KEY, type SessionEntries } from "../shared/sessionKeys";
import { approvePairingLocal, denyPairing, lookupPairing } from "./api";
import { getApiBaseUrl } from "./apiHost";
import { scopeLogger } from "./logger";

const logger = scopeLogger("sibling");
const LIBRARY_KEY_STORAGE = "sf_client_library_key";

/** The signed-in account in the window's session entries (`sf_client_token`, `sf_client_user`, the scoped key). */
export const siblingAccountOf = (entries: SessionEntries): SiblingAccount | null => {
  const token = entries[AUTH_TOKEN_KEY]?.trim();
  const rawUser = entries.sf_client_user;
  if (!token || !rawUser) return null;
  let user: { id?: unknown; email?: unknown };
  try {
    user = JSON.parse(rawUser) as { id?: unknown; email?: unknown };
  } catch {
    return null;
  }
  if (typeof user?.id !== "string" || !user.id.trim() || typeof user.email !== "string" || !user.email.trim()) return null;
  const id = user.id.trim();
  const libraryKey = (entries[`${LIBRARY_KEY_STORAGE}:${id}`] ?? entries[LIBRARY_KEY_STORAGE])?.replace(/\s+/g, "") || null;
  return { token, user: { id, email: user.email.trim() }, libraryKey: async () => libraryKey };
};

export const createBadgerSiblingHost = (options: { onAnswered?: () => void } = {}): SiblingHost => {
  const platform = getDesktopPlatform();
  return createSiblingHost({
    app: "badger",
    place: {
      dir: resolveSiblingDir({ userDataBase: platform.paths.userDataBase, dev: isDesktopDevBuild(currentDesktopBuildEnv()) }),
      ownerOnly: { file: platform.paths.restrictFileToOwner, dir: platform.paths.restrictDirToOwner },
      namedPipe: platform.id === "windows",
    },
    launch: siblingLaunchTarget({ execPath: process.execPath, argv: process.argv, defaultApp: Boolean(process.defaultApp), env: process.env }),
    deviceName: resolveDeviceName(osHostname()),
    api: { lookup: lookupPairing, approveLocal: approvePairingLocal, deny: denyPairing },
    // Its own pairing client: the "Sign in with another device" screen keeps its own request.
    pairing: createDesktopPairingClient({ getApiBaseUrl, appId: "badger", log: (message, extra) => logger.info(extra ?? {}, message) }),
    log: (message, extra) => logger.info(extra ?? {}, message),
    onAnswered: options.onAnswered,
  });
};

/** The sign-in screen's card: the offer, the one-click sign-in (the hand-over goes to the window) and Cancel. */
export const registerSiblingIpc = (host: SiblingHost): void => {
  ipcMain.handle(SIBLING_IPC.offer, (): SiblingOffer | null => host.offer());
  ipcMain.handle(SIBLING_IPC.signIn, (): Promise<SiblingSignInResult> => host.signIn());
  ipcMain.handle(SIBLING_IPC.cancel, () => host.cancel());
};

