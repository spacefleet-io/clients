import { join } from "node:path";

/**
 * Resolve the directories the runtime derives from Electron's userData and
 * publish them on `env` (normally `process.env`), keeping explicit overrides.
 *
 * This is the single source of truth for `SF_TRANSCODE_DIR` and
 * `SF_BADGER_OFFLINE_DIR`. It MUST run before the first `guardian.start()`
 * (and before the `RuntimeGuardian` is built, whose spawn command carries a
 * snapshot of the env): the variables used to be set inside window creation,
 * which runs after that first start, so they never reached the first runtime.
 * That runtime then fell
 * back to `<cwd>/.runtime/transcode` while every restarted runtime used
 * `<userData>/transcode`, splitting `job_state.json` (crash-resume state)
 * across two directories (ultimate stress finding F7, issue #25).
 *
 * Override semantics are unchanged: an empty/unset variable counts as unset.
 */
export const applyUserDataDirDefaults = (
  env: NodeJS.ProcessEnv,
  userDataPath: string,
): { transcodeDir: string; offlineDir: string; transcodeDirSource: "env" | "userData"; offlineDirSource: "env" | "userData" } => {
  const transcodeDirSource = env.SF_TRANSCODE_DIR ? "env" : "userData";
  if (!env.SF_TRANSCODE_DIR) {
    env.SF_TRANSCODE_DIR = join(userDataPath, "transcode");
  }
  // Offline downloads (Phase 2 of let-s-talk-about-offline). Without this, the
  // runtime's fallback in modules/index.ts lands plaintext under the platform's
  // default runtime data dir (desktop-platform paths.runtimeDataDir — app-internal
  // state, not a place the user looks), which we do not want for user-retained media files.
  // Plaintext lives at <userData>/offline/<libraryId>/<sanitized-title>.<ext>.
  const offlineDirSource = env.SF_BADGER_OFFLINE_DIR ? "env" : "userData";
  if (!env.SF_BADGER_OFFLINE_DIR) {
    env.SF_BADGER_OFFLINE_DIR = join(userDataPath, "offline");
  }
  return {
    transcodeDir: env.SF_TRANSCODE_DIR,
    offlineDir: env.SF_BADGER_OFFLINE_DIR,
    transcodeDirSource,
    offlineDirSource,
  };
};

/**
 * Environment handed to every runtime the guardian spawns (first spawn and
 * every respawn alike). Applies {@link applyUserDataDirDefaults} to `env`
 * first so the result and `process.env` agree on the data directories.
 */
export const buildRuntimeSpawnEnv = (
  env: NodeJS.ProcessEnv,
  userDataPath: string,
  runtimePort: string | undefined,
): Record<string, string> => {
  applyUserDataDirDefaults(env, userDataPath);
  return Object.fromEntries(
    Object.entries({
      ...env,
      SF_USER_DATA_PATH: userDataPath,
      ...(runtimePort ? { PORT: runtimePort } : {}),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

/** The port of the runtime a release build manages (apps/runtime's default). */
export const RELEASE_RUNTIME_PORT = 3020;
/** The port of the runtime a development build manages (PLAT-DESK-14): never the release build's. */
export const DEV_BUILD_RUNTIME_PORT = 3021;

/**
 * PLAT-DESK-14: a development build (`electron-vite dev`, test builds) never shares the release build's runtime. Both
 * builds used port 3020 and one runtime data dir, so whichever started second attached to the other's runtime, with
 * its server, account and job queue. For a development build this fills `SF_RUNTIME_BASE_URL` (port
 * {@link DEV_BUILD_RUNTIME_PORT}) and `SPACEFLEET_RUNTIME_DATA_DIR` (`<release runtime data dir>-dev`) on `env`;
 * values the caller set (lanes, e2e) win. A release build is left alone. It MUST run before the main modules that
 * read `SF_RUNTIME_BASE_URL` at load time (see devBuildEnv.ts).
 */
export const applyDevBuildRuntimeDefaults = (
  env: NodeJS.ProcessEnv,
  devBuild: boolean,
  releaseRuntimeDataDir: string,
): { runtimeBaseUrl: string | null; runtimeDataDir: string | null } => {
  if (devBuild) {
    if (!env.SF_RUNTIME_BASE_URL?.trim()) env.SF_RUNTIME_BASE_URL = `http://127.0.0.1:${DEV_BUILD_RUNTIME_PORT}`;
    if (!env.SPACEFLEET_RUNTIME_DATA_DIR?.trim()) env.SPACEFLEET_RUNTIME_DATA_DIR = `${releaseRuntimeDataDir}-dev`;
  }
  return {
    runtimeBaseUrl: env.SF_RUNTIME_BASE_URL?.trim() || null,
    runtimeDataDir: env.SPACEFLEET_RUNTIME_DATA_DIR?.trim() || null,
  };
};

/**
 * Whether `runtimeBaseUrl` points at a runtime this app does not manage (e2e's external runtime): any port other than
 * the one the release or a development build spawns its own runtime on.
 */
export const isExternalRuntimeUrl = (runtimeBaseUrl: string | undefined): boolean => {
  const url = runtimeBaseUrl?.trim();
  if (!url) return false;
  const port = Number(url.match(/:(\d+)(?:\/|$)/)?.[1]);
  return port !== RELEASE_RUNTIME_PORT && port !== DEV_BUILD_RUNTIME_PORT;
};
