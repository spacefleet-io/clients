import {
  createKeyChange,
  KEY_CHANGE_IDLE,
  type KeyChange,
  type KeyChangeApp,
  type KeyChangeOptions,
  type KeyChangeOutcome,
  type KeyChangeState,
  type UnreadableFile,
} from "@space/media-reseal";
import { keyChangeFailureOf } from "@space/shared/keyChangeFailure";
import type { KeyRotationReadiness } from "@space/shared/keyChange";
import type { NewLibraryKey } from "@space/shared/libraryKeyWords";
import type { ParrotKeyChangeOpen, ParrotKeyChangeResult } from "../shared/ipc";

export type ParrotKeyChangeDeps = {
  token(): string | null;
  /** A new key's words, in the app's language. */
  newKey(): NewLibraryKey;
  /** ACCT-AUTH-04: an account without a password is asked a code instead. */
  hasPassword(token: string): Promise<boolean>;
  /** `GET /library/recovery/rotate` (ACCT-KEYCHG-04). */
  readiness(token: string): Promise<KeyRotationReadiness>;
  /** How Parrot's library is sealed and Badger's re-encrypted for this session. */
  app(token: string): KeyChangeApp;
  /** The window follows the re-seal (STOR-RESEAL-01, ACCT-KEYCHG-09). */
  onState(state: KeyChangeState): void;
  /** After the switch: keep the new key and sign out (the rotation revoked every session). */
  onSwitched(newKeyBase64: string): Promise<void>;
  log(message: string): void;
  create?: (options: KeyChangeOptions) => KeyChange;
};

/**
 * Parrot desktop's key change (ACCT-KEYCHG-01, Chris 2026-11-23 Q2): run in the main process, where the session and
 * the library live, on the controller Badger desktop runs too (`createKeyChange`). Parrot's library is sealed under the
 * new key, Badger's re-encrypted alongside (PRIV-KEY-06), and every media file re-sealed first (STOR-RESEAL-01). One
 * key change per dialog: opening it makes a new key and drops the previous one (its run is restarted with the new key,
 * never finished with another). Outcomes and failures are plain data, so they cross Electron IPC as is.
 */
export const createParrotKeyChange = (deps: ParrotKeyChangeDeps) => {
  const create = deps.create ?? createKeyChange;
  let current: { key: NewLibraryKey; change: KeyChange } | null = null;

  const step = async (what: string, run: (change: KeyChange) => Promise<KeyChangeOutcome | null>): Promise<ParrotKeyChangeResult> => {
    const held = current;
    if (!held) return { status: "failed", reason: "other" };
    try {
      const outcome = await run(held.change);
      if (outcome === null) return { status: "waiting" };
      if (outcome === "switched") {
        current = null;
        deps.log(`[key-change] ${what}: the media library key changed; signing out`);
        await deps.onSwitched(held.key.keyBase64);
      } else {
        deps.log(`[key-change] ${what}: ${outcome}`);
      }
      return { status: outcome };
    } catch (error) {
      const failure = keyChangeFailureOf(error);
      deps.log(`[key-change] ${what} refused: ${JSON.stringify(failure)} (${error instanceof Error ? error.message : String(error)})`);
      return failure;
    }
  };

  return {
    /** ACCT-KEYCHG-04: null while signed out or when the server does not answer (the entry stays hidden). */
    readiness: async (): Promise<KeyRotationReadiness | null> => {
      const token = deps.token();
      if (!token) return null;
      return deps.readiness(token).then(
        (answer) => ({ needsMediaReseal: answer.needsMediaReseal }),
        () => null,
      );
    },

    /** The dialog opened: a new key's words to write down. */
    open: async (): Promise<ParrotKeyChangeOpen> => {
      const token = deps.token();
      if (!token) return { ok: false };
      current?.change.pause();
      const key = deps.newKey();
      const change = create({ token, newKeyBase64: key.keyBase64, app: deps.app(token), onState: deps.onState });
      current = { key, change };
      deps.onState(KEY_CHANGE_IDLE);
      const hasPassword = await deps.hasPassword(token).catch(() => true);
      return { ok: true, words: key.words, hasPassword };
    },

    /** Start (ACCT-KEYCHG-03) from the form; Finish (or try again) once a run is open. */
    submit: (password: string, twoFactorCode?: string) =>
      step("submit", (change) =>
        change.state().phase === "form"
          ? change.start({ password, ...(twoFactorCode ? { twoFactorCode } : {}) })
          : change.resume(),
      ),

    /** "Switch now" (ACCT-KEYCHG-06). */
    switchNow: () => step("switch now", (change) => change.switchNow()),

    /** While waiting (STOR-RESEAL-08): switches once the other device's uploads ended. */
    poll: () => step("poll", (change) => change.poll()),

    /** Stop (ACCT-KEYCHG-08, confirmed): the copies are deleted, the library stays as it was (STOR-RESEAL-07). */
    stop: async (): Promise<ParrotKeyChangeResult> => {
      const held = current;
      if (!held) return { status: "stopped" };
      try {
        await held.change.stop();
      } catch (error) {
        return keyChangeFailureOf(error);
      }
      current = null;
      deps.log("[key-change] stopped; the copies are deleted");
      return { status: "stopped" };
    },

    /** Leaving Settings or quitting: the copying pauses between files. */
    pause: () => current?.change.pause(),

    /** ACCT-KEYCHG-07: the files the old key could not open. */
    unreadableFiles: (): Promise<UnreadableFile[]> => current?.change.unreadableFiles().catch(() => []) ?? Promise.resolve([]),

    deleteUnreadableFiles: async (files: UnreadableFile[]): Promise<boolean> => {
      if (!current) return false;
      try {
        await current.change.deleteUnreadableFiles(files);
        return true;
      } catch (error) {
        deps.log(`[key-change] could not delete ${files.length} unreadable file(s): ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
};
