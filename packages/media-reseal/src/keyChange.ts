/**
 * A key change with media, the same on every app that can make one (ACCT-KEYCHG-01): the password and code are checked
 * when the re-seal run opens (ACCT-KEYCHG-03), every media file is copied under the new key (STOR-RESEAL-01), then this
 * app's library and the other app's, their references renamed to the copies, switch in one request with the media
 * (STOR-RESEAL-04). An account without media switches at once. The screens only show `KeyChangeState` and call these
 * steps; each app gives how its library is sealed (`KeyChangeApp`).
 */
import {
  abandonMediaResealRun,
  ApiError,
  deleteStorageObjects,
  getKeyRotationReadiness,
  getMediaResealRun,
  openMediaResealRun,
  rotateLibraryKey,
  type RotationLibraryCopy,
  type RotationOwnLibrary,
} from "@space/shared/api";
import type { SpaceAppId } from "@space/shared/appScope";
import { collectResealCopies, RESEAL_PAGE_MAX, resealIoForRun, runMediaReseal, type ResealIo, type ResealRunProgress } from "./run";
import { importResealKeyFromBase64 } from "./sealing";

/** Bytes moved (downloaded plus uploaded) at a moment. */
export type TransferSample = { at: number; bytes: number };

/** The rate behind the estimate is measured over the last two minutes. */
export const ETA_WINDOW_MS = 120_000;
/** Below this much measured time the rate is noise: no estimate yet. */
const ETA_MIN_SPAN_MS = 5_000;

/** Adds a sample and drops the ones older than the window. */
export const pushTransferSample = (samples: readonly TransferSample[], sample: TransferSample): TransferSample[] => [
  ...samples.filter((s) => sample.at - s.at <= ETA_WINDOW_MS),
  sample,
];

/**
 * ACCT-KEYCHG-09: seconds left at the recent rate, counting every byte still to move: the download of each file left and
 * the upload of its copy (`transferBytes` holds both). Null until a rate is known.
 */
export const resealSecondsLeft = (samples: readonly TransferSample[], progress: ResealRunProgress): number | null => {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.at - first.at < ETA_MIN_SPAN_MS || last.bytes <= first.bytes) return null;
  const bytesPerSecond = (last.bytes - first.bytes) / ((last.at - first.at) / 1000);
  return Math.ceil(Math.max(0, progress.transferBytes - progress.transferredBytes) / bytesPerSecond);
};

/** A file the old key could not open (STOR-RESEAL-05): kept as it is, listed for the user to delete (ACCT-KEYCHG-07). */
export type UnreadableFile = { key: string; sizeBytes: number };

/** Every file of the run the old key could not open. */
export const listUnreadableFiles = async (io: Pick<ResealIo, "copies">): Promise<UnreadableFile[]> => {
  const files: UnreadableFile[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await io.copies(after, RESEAL_PAGE_MAX);
    for (const copy of page.copies) if (copy.kept) files.push({ key: copy.oldKey, sizeBytes: copy.sizeBytes });
    if (!page.nextAfter) return files;
    after = page.nextAfter;
  }
};

/** ACCT-KEYCHG-06: "Switch now" opens once the server says so (`switchNowAt`, 24 h after the switch first waited). */
export const switchNowOpen = (switchNowAt: string | null, now: number): boolean =>
  switchNowAt !== null && Date.parse(switchNowAt) <= now;

/** How often a waiting switch asks whether the other device's uploads ended. */
export const KEY_CHANGE_WAIT_POLL_MS = 15_000;

/**
 * Where a key change stands. `form`: nothing started; `resealing`: media files being copied (STOR-RESEAL-01); `ready`:
 * the copying stopped (an error, the screen left) or the switch was refused, Finish carries on; `waiting`: the switch
 * waits on another device's uploads (STOR-RESEAL-08), "Switch now" after `switchNowAt` (ACCT-KEYCHG-06).
 */
export type KeyChangePhase = "form" | "resealing" | "ready" | "waiting";

export type KeyChangeState = {
  phase: KeyChangePhase;
  progress: ResealRunProgress | null;
  etaSeconds: number | null;
  uploadsInFlight: number;
  switchNowAt: string | null;
};

export const KEY_CHANGE_IDLE: KeyChangeState = { phase: "form", progress: null, etaSeconds: null, uploadsInFlight: 0, switchNowAt: null };

/** What differs between the apps: how this app's library is sealed, and the other app's re-encrypted. */
export type KeyChangeApp = {
  /** The app whose library `sealOwnLibrary` seals: the rotation is made in its name. */
  appId: SpaceAppId;
  /** The key the library and media are sealed with now; null when this device does not hold it. */
  oldKey(): Promise<string | null>;
  /** PRIV-KEY-13: this app's library as a snapshot under the new key, its media references renamed to `copies`. */
  sealOwnLibrary(newKeyBase64: string, copies: ReadonlyMap<string, string>): Promise<RotationOwnLibrary>;
  /** PRIV-KEY-06: the other app's library re-encrypted under the new key, its references renamed to `copies`. */
  reencryptOtherLibraries(oldKeyBase64: string, newKeyBase64: string, copies: ReadonlyMap<string, string>): Promise<RotationLibraryCopy[]>;
  /** The account's key probe for the new key. */
  keyProbe(newKeyBase64: string): Promise<string>;
};

export type KeyChangeOptions = {
  token: string;
  newKeyBase64: string;
  app: KeyChangeApp;
  onState?: (state: KeyChangeState) => void;
  /** ACCT-KEYCHG-05: awaited before each file; a phone on mobile data holds it until Wi-Fi or the user allows mobile data. */
  beforeFile?: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type KeyChangeCredentials = { password: string; twoFactorCode?: string };

/** `switched`: the key changed and every session ended; `stopped`: the copying paused (Finish resumes it); `waiting`: see the phase. */
export type KeyChangeOutcome = "switched" | "stopped" | "waiting";

const numberOr = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);

export type KeyChange = {
  state(): KeyChangeState;
  /** Start: the password (and code) is checked first; a code request comes back as the API's `two_factor_required`. */
  start(credentials: KeyChangeCredentials): Promise<KeyChangeOutcome>;
  /** Finish (or try again) after a refused switch or interrupted copying. */
  resume(): Promise<KeyChangeOutcome>;
  /** "Switch now" (ACCT-KEYCHG-06): the other device's unfinished uploads are cancelled (STOR-RESEAL-10). */
  switchNow(): Promise<KeyChangeOutcome>;
  /** While waiting: asks the run whether the other uploads ended, and switches when they did. */
  poll(): Promise<KeyChangeOutcome | null>;
  /** Stop (ACCT-KEYCHG-08, confirmed): the copies are deleted and the library stays as it was (STOR-RESEAL-07). */
  stop(): Promise<void>;
  /** Leaving the screen: the copying pauses between files; the run keeps what was copied. */
  pause(): void;
  unreadableFiles(): Promise<UnreadableFile[]>;
  /** Deletes the unreadable files; they were lost already (STOR-RESEAL-05). */
  deleteUnreadableFiles(files: readonly UnreadableFile[]): Promise<void>;
};

export const createKeyChange = (options: KeyChangeOptions): KeyChange => {
  const { token, newKeyBase64, app } = options;
  const now = options.now ?? Date.now;
  let state = KEY_CHANGE_IDLE;
  /**
   * The run this key change re-seals into. Its copies are sealed with this key change's new key, which lives only
   * here: a run left open by an earlier key change is stopped and opened afresh (`restart`), never finished with another key.
   */
  let runId: string | null = null;
  let abort: AbortController | null = null;
  let task: Promise<unknown> | null = null;
  let samples: TransferSample[] = [];

  const set = (patch: Partial<KeyChangeState>) => {
    state = { ...state, ...patch };
    options.onState?.(state);
  };

  /** The switch, with credentials only when no run was opened (an account without media). */
  const switchKey = async (credentials: KeyChangeCredentials | null, switchNow: boolean): Promise<KeyChangeOutcome> => {
    const run = runId;
    try {
      const copies = run ? await collectResealCopies(resealIoForRun(token, run)) : new Map<string, string>();
      const library = await app.sealOwnLibrary(newKeyBase64, copies);
      const keyProbe = await app.keyProbe(newKeyBase64);
      // PRIV-KEY-06: without the old key here no copy is sent, and the server refuses if the other app has a library.
      const oldKey = await app.oldKey();
      const others = oldKey ? await app.reencryptOtherLibraries(oldKey, newKeyBase64, copies) : [];
      await rotateLibraryKey(
        token,
        library,
        keyProbe,
        // ACCT-KEYCHG-03: a switch that names the run this session opened (and re-authenticated) is asked nothing.
        run ? undefined : credentials?.password,
        run ? undefined : credentials?.twoFactorCode,
        others,
        run ? { runId: run, ...(switchNow ? { switchNow: true } : {}) } : undefined,
        app.appId
      );
      runId = null;
      set(KEY_CHANGE_IDLE);
      return "switched";
    } catch (err) {
      if (!run) throw err;
      if (err instanceof ApiError && err.payload.error === "uploads_in_flight") {
        // STOR-RESEAL-08: another device is uploading; the switch waits for it (ACCT-KEYCHG-06).
        set({
          phase: "waiting",
          uploadsInFlight: numberOr(err.payload.uploadsInFlight, 1),
          switchNowAt: typeof err.payload.switchNowAt === "string" ? err.payload.switchNowAt : null,
        });
        return "waiting";
      }
      if (err instanceof ApiError && err.payload.error === "reseal_run_not_open") {
        runId = null;
        set(KEY_CHANGE_IDLE);
      } else {
        set({ phase: "ready" });
      }
      throw err;
    }
  };

  /** Re-seals what the run still lists (files added meanwhile included), then switches. */
  const resealThenSwitch = async (): Promise<KeyChangeOutcome> => {
    const run = runId;
    if (!run) throw new Error("reseal_run_missing");
    const oldKey = await app.oldKey();
    if (!oldKey) throw new Error("LIBRARY_KEY_MISSING");
    const keys = { from: await importResealKeyFromBase64(oldKey), to: await importResealKeyFromBase64(newKeyBase64) };
    const controller = new AbortController();
    abort = controller;
    samples = [];
    set({ phase: "resealing", etaSeconds: null });
    const running = runMediaReseal(resealIoForRun(token, run), keys, {
      signal: controller.signal,
      ...(options.beforeFile ? { beforeFile: options.beforeFile } : {}),
      onProgress: (progress) => {
        samples = pushTransferSample(samples, { at: now(), bytes: progress.transferredBytes });
        set({ progress, etaSeconds: resealSecondsLeft(samples, progress) });
      },
    });
    task = running.catch(() => undefined);
    let result: Awaited<typeof running>;
    try {
      result = await running;
    } catch (err) {
      set({ phase: "ready" });
      if (controller.signal.aborted) return "stopped";
      throw err;
    } finally {
      if (abort === controller) abort = null;
    }
    if (result.stopped) {
      set({ phase: "ready" });
      return "stopped";
    }
    set({ phase: "ready" });
    return switchKey(null, false);
  };

  return {
    state: () => state,
    start: async (credentials) => {
      const { needsMediaReseal } = await getKeyRotationReadiness(token);
      if (!needsMediaReseal) return switchKey(credentials, false);
      // ACCT-KEYCHG-03: the password and code are checked as the run opens, before any file is copied. `restart`: a
      // run left open by an earlier key change holds copies under a key this one does not have; it is abandoned in
      // the same request, under the same code.
      const { run } = await openMediaResealRun(token, {
        password: credentials.password,
        ...(credentials.twoFactorCode ? { twoFactorCode: credentials.twoFactorCode } : {}),
        restart: true,
      });
      runId = run.id;
      return resealThenSwitch();
    },
    resume: () => resealThenSwitch(),
    switchNow: () => switchKey(null, true),
    poll: async () => {
      const run = runId;
      if (state.phase !== "waiting" || !run) return null;
      const progress = await getMediaResealRun(token, run, { limit: 1 });
      set({ uploadsInFlight: progress.uploadsInFlight, switchNowAt: progress.switchNowAt });
      return progress.uploadsInFlight === 0 ? switchKey(null, false) : null;
    },
    stop: async () => {
      abort?.abort();
      await task;
      const run = runId;
      if (run) {
        try {
          await abandonMediaResealRun(token, run);
        } catch (err) {
          set({ phase: "ready" });
          throw err;
        }
      }
      runId = null;
      set(KEY_CHANGE_IDLE);
    },
    pause: () => abort?.abort(),
    unreadableFiles: async () => (runId ? listUnreadableFiles(resealIoForRun(token, runId)) : []),
    deleteUnreadableFiles: async (files) => {
      const keys = files.map((file) => file.key);
      for (let i = 0; i < keys.length; i += RESEAL_PAGE_MAX) await deleteStorageObjects(token, keys.slice(i, i + RESEAL_PAGE_MAX));
    },
  };
};
