/**
 * ACCT-PAIR-07: one app's whole part in same-device sign-in on a computer, for Badger desktop and Parrot desktop alike.
 *
 *   signed in  -> `setAccount(account)`: publish the status file (app, email, user id, how to start it) and listen on
 *                 the local channel, so the sister app can offer "Continue with your … account".
 *   signed out -> `setAccount(null)`: remove both.
 *   asking     -> `offer()` / `signIn()` / `cancel()`: the window's card, through this app's own pairing request.
 */
import type { SpaceAppId } from "@space/shared/appScope";
import { startSiblingServer, type SiblingServer, type SiblingServerOptions } from "./channel";
import type { SiblingPlace } from "./place";
import { createSiblingSignIn, type SiblingPairing, type SiblingSignIn } from "./signIn";
import { removeSiblingStatus, writeSiblingStatus } from "./status";

type Log = (message: string, extra?: Record<string, unknown>) => void;

/** The signed-in session as main holds it. The library key is read only when the sister app asks. */
export type SiblingAccount = {
  token: string;
  user: { id: string; email: string };
  libraryKey: () => Promise<string | null>;
};

export type SiblingHostOptions = {
  app: SpaceAppId;
  place: SiblingPlace;
  /** How the sister app starts this one in the background (`siblingLaunchTarget`). */
  launch: { exePath: string; args: string[] };
  /** This computer's name as the asking app announces it (`resolveDeviceName`). */
  deviceName: string;
  api: SiblingServerOptions["api"];
  pairing: SiblingPairing;
  log?: Log;
  /** After an approve or refuse was answered (the hidden start quits soon after). */
  onAnswered?: () => void;
  pid?: number;
};

export type SiblingHost = Pick<SiblingSignIn, "offer" | "signIn" | "cancel"> & {
  setAccount: (account: SiblingAccount | null) => Promise<void>;
  close: () => Promise<void>;
};

export const createSiblingHost = (options: SiblingHostOptions): SiblingHost => {
  const { app, place } = options;
  const log: Log = options.log ?? (() => undefined);
  let account: SiblingAccount | null = null;
  let published: string | null = null;
  let server: SiblingServer | null = null;
  // One change at a time: a sign-in right after a sign-out never races the socket.
  let queue: Promise<void> = Promise.resolve();

  const apply = async (next: SiblingAccount | null) => {
    account = next;
    if (!next) {
      // Also at startup: a status left by an earlier run must not offer an account this app no longer holds.
      removeSiblingStatus(place, app);
      if (published !== null) log("sibling: status removed", { app });
      published = null;
      if (server) {
        const closing = server;
        server = null;
        await closing.close();
      }
      return;
    }
    const key = `${next.user.id}|${next.user.email}`;
    if (published !== key) {
      writeSiblingStatus(place, {
        app,
        email: next.user.email,
        userId: next.user.id,
        exePath: options.launch.exePath,
        args: options.launch.args,
        pid: options.pid ?? process.pid,
      });
      published = key;
      log("sibling: status published", { app });
    }
    if (!server) {
      try {
        server = await startSiblingServer({
          place,
          app,
          deviceName: options.deviceName,
          token: () => account?.token ?? null,
          libraryKey: async () => (account ? account.libraryKey() : null),
          api: options.api,
          log,
          onAnswered: options.onAnswered,
        });
      } catch (err) {
        // Another copy of this app (a dev and a release build share no folder, so this is rare) holds the channel.
        log("sibling: cannot listen", { app, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const signIn = createSiblingSignIn({ place, app, pairing: options.pairing, log });

  return {
    setAccount: (next) => {
      queue = queue.then(() => apply(next)).catch((err) => log("sibling: account change failed", { message: err instanceof Error ? err.message : String(err) }));
      return queue;
    },
    offer: signIn.offer,
    signIn: signIn.signIn,
    cancel: signIn.cancel,
    close: async () => {
      signIn.cancel();
      // The status stays: the app is still signed in and can be started in the background. Only the socket goes.
      await queue;
      const closing = server;
      server = null;
      await closing?.close();
    },
  };
};
