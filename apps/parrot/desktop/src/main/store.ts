import {
  createSecretFile,
  secretSafeStorage,
  taggedSecretFormat,
  writeFileDurably,
} from "@space/desktop-platform/secret-file";
import { safeStorage } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUploadsDuringPlayback, type UploadsDuringPlayback } from "@space/content-core/uploadPlaybackGate";
import { keepsKeyOnSignIn, keyAfterSignedOut, type SignedOutReason } from "@space/shared/keptLibraryKey";
import { PARROT_SETUP_STEPS, type ParrotLanguage, type ParrotSetupState, type ParrotUser } from "../shared/ipc";
import { createSaveChain, type SaveChain } from "./saveChain";

/**
 * What Parrot keeps in `<userData>/parrot.json`: the setup answers, who is signed in, and whose library key stayed
 * after the server refused their session (only that account gets it back), and the automatic-updates setting
 * (REL-UPD-01, ON unless turned off), and what imports do while a song plays on this computer (PAR-UP-15; null
 * until the user picks: the hardware's recommendation applies). Never the token or the key.
 */
type StoredState = {
  version: 1;
  setup: ParrotSetupState;
  user: ParrotUser | null;
  keyOwnerId: string | null;
  autoUpdate: boolean;
  uploadsWhilePlaying: UploadsDuringPlayback | null;
};

/**
 * The settings file plus the two secrets (session token, library key), each in its own `<name>.secret` file sealed
 * by the operating system's protected storage (`@space/desktop-platform/secret-file`, `enc:`/`raw:` layout). The
 * secrets are read once when the store opens (`safeStorage` decrypts asynchronously) and served from memory.
 */
export type ParrotStore = {
  readonly setup: ParrotSetupState;
  readonly user: ParrotUser | null;
  /** REL-UPD-01: install new versions automatically (the default). */
  readonly autoUpdate: boolean;
  /** The in-memory value changes at once; resolves once `parrot.json` is durable, rejects if it cannot be written. */
  setAutoUpdate(enabled: boolean): Promise<void>;
  /** PAR-UP-15: this computer's pick, null while none (the hardware's recommendation applies). */
  readonly uploadsWhilePlaying: UploadsDuringPlayback | null;
  /** The in-memory value changes at once; resolves once `parrot.json` is durable, rejects if it cannot be written. */
  setUploadsWhilePlaying(mode: UploadsDuringPlayback): Promise<void>;
  /** The in-memory value changes at once; resolves once `parrot.json` is durable, rejects if it cannot be written. */
  updateSetup(patch: Partial<ParrotSetupState>): Promise<void>;
  signIn(user: ParrotUser, token: string): Promise<void>;
  /**
   * Forgets the session; the setup answers stay. The library key goes too on a Sign out, but stays after a refused
   * session, remembered as that account's.
   */
  signOut(reason: SignedOutReason): Promise<void>;
  token(): string | null;
  libraryKey(): string | null;
  setLibraryKey(keyBase64: string): Promise<void>;
  /** After the account's library was erased (PRIV-KEY-01): the key opens nothing any more. */
  clearLibraryKey(): void;
  /** The `parrot.json` writes still queued: a quit waits for them (PAR-PL-05). */
  readonly writes: Pick<SaveChain, "pending" | "idle">;
};

export const openParrotStore = async (input: {
  dir: string;
  defaultSetup: () => ParrotSetupState;
  log: (line: string) => void;
}): Promise<ParrotStore> => {
  const statePath = join(input.dir, "parrot.json");
  const sealed = secretSafeStorage(safeStorage);
  const secretFile = (name: "session" | "library-key") =>
    createSecretFile({
      path: join(input.dir, `${name}.secret`),
      format: taggedSecretFormat,
      safeStorage: sealed,
      log: input.log,
      label: `store ${name}`,
    });
  const sessionFile = secretFile("session");
  const libraryKeyFile = secretFile("library-key");

  const readState = (): StoredState => {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<StoredState>;
      const setup = { ...input.defaultSetup(), ...parsed.setup };
      if (!PARROT_SETUP_STEPS.includes(setup.step)) setup.step = "language";
      return {
        version: 1,
        setup,
        user: parsed.user?.id ? parsed.user : null,
        keyOwnerId: typeof parsed.keyOwnerId === "string" ? parsed.keyOwnerId : null,
        // A file from before REL-UPD-01 has no answer: automatic updates are on.
        autoUpdate: parsed.autoUpdate !== false,
        uploadsWhilePlaying: isUploadsDuringPlayback(parsed.uploadsWhilePlaying) ? parsed.uploadsWhilePlaying : null,
      };
    } catch {
      return { version: 1, setup: input.defaultSetup(), user: null, keyOwnerId: null, autoUpdate: true, uploadsWhilePlaying: null };
    }
  };
  let state = readState();
  let token = await sessionFile.read();
  let libraryKey = await libraryKeyFile.read();
  /**
   * `parrot.json` writes, one at a time in call order, off the event loop (PERF-TIME-02: a sync fsync froze Electron
   * main for seconds while an upload filled the page cache). Each write carries the state at its call.
   */
  const writes = createSaveChain();
  const save = (): Promise<void> => {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    return writes.run(() => writeFileDurably(statePath, body));
  };

  return {
    get setup(): ParrotSetupState {
      return state.setup;
    },
    get user(): ParrotUser | null {
      return state.user;
    },
    get autoUpdate(): boolean {
      return state.autoUpdate;
    },
    setAutoUpdate(enabled: boolean) {
      state = { ...state, autoUpdate: enabled };
      return save();
    },
    get uploadsWhilePlaying(): UploadsDuringPlayback | null {
      return state.uploadsWhilePlaying;
    },
    setUploadsWhilePlaying(mode: UploadsDuringPlayback) {
      state = { ...state, uploadsWhilePlaying: mode };
      return save();
    },
    updateSetup(patch: Partial<ParrotSetupState>) {
      state = { ...state, setup: { ...state.setup, ...patch } };
      return save();
    },
    async signIn(user: ParrotUser, sessionToken: string) {
      if (!keepsKeyOnSignIn({ keyOwnerId: state.keyOwnerId, signedInUserId: user.id })) {
        input.log("[store] kept library key belongs to another account: dropped");
        libraryKeyFile.remove();
        libraryKey = null;
      }
      await sessionFile.write(sessionToken);
      token = sessionToken;
      state = { ...state, user, keyOwnerId: null };
      await save();
    },
    async signOut(reason: SignedOutReason) {
      const keepKey = keyAfterSignedOut(reason) === "keep" && libraryKey !== null;
      sessionFile.remove();
      token = null;
      if (!keepKey) {
        libraryKeyFile.remove();
        libraryKey = null;
      }
      state = { ...state, user: null, keyOwnerId: keepKey ? (state.user?.id ?? state.keyOwnerId) : null };
      input.log(`[store] signed out (${reason}), library key ${keepKey ? "kept" : "forgotten"}`);
      await save();
    },
    token: () => token,
    libraryKey: () => libraryKey,
    async setLibraryKey(keyBase64: string) {
      await libraryKeyFile.write(keyBase64);
      libraryKey = keyBase64;
      if (state.keyOwnerId !== null) {
        state = { ...state, keyOwnerId: null };
        await save();
      }
    },
    clearLibraryKey() {
      libraryKeyFile.remove();
      libraryKey = null;
      input.log("[store] library key forgotten (library erased)");
    },
    writes,
  };
};

export const parrotLanguageFor = (locale: string): ParrotLanguage => {
  const base = locale.toLowerCase().slice(0, 2);
  return base === "fr" || base === "nl" || base === "de" || base === "es" ? base : "en";
};
