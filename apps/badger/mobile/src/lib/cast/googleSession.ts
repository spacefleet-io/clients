/**
 * Starts the Google Cast session of a cast (UX-TV-03). The session manager is injected (`CastContext.getSessionManager()` in
 * production, a fake in the tests): what matters here is the order of the steps and that no listener outlives the attempt.
 */

type Removable = { remove: () => void };

/** The part of a Cast session this flow reads. */
export type GoogleSessionLike = { getCastDevice: () => Promise<{ deviceId: string } | null> };

/** The part of the Cast `SessionManager` this flow uses. */
export type GoogleSessionManager<S extends GoogleSessionLike> = {
  getCurrentCastSession: () => Promise<S | null>;
  endCurrentSession: (stopCasting: boolean) => Promise<unknown>;
  startSession: (deviceId: string) => Promise<unknown>;
  onSessionStarted: (listener: (session: S) => void) => Removable;
  onSessionStartFailed: (listener: (session: S, error: string) => void) => Removable;
};

/**
 * How long a session start may take before the cast gives up. Launching Google's Default Media Receiver took about 4 s on a
 * Google TV (MiTV-AFMU1); a start that neither starts nor fails (the route the SDK selected vanished, seen on that TV) would
 * otherwise leave the Cast screen on "Connecting..." for good.
 */
export const SESSION_START_TIMEOUT_MS = 30_000;

type ConnectOptions = {
  /** Aborted when the Cast screen closes: the attempt drops its listeners, so a later session cannot reach a closed screen. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * Starts the session to `deviceId` (reusing a live one to the same device) and resolves with it; rejects when it cannot start,
 * when it takes longer than `timeoutMs`, or when `signal` aborts. No listener outlives the attempt: a stale one would take the
 * NEXT session started on the phone for its own and end it.
 */
export const connectGoogleSession = async <S extends GoogleSessionLike>(
  manager: GoogleSessionManager<S>,
  deviceId: string,
  { signal, timeoutMs = SESSION_START_TIMEOUT_MS }: ConnectOptions = {},
): Promise<S> => {
  const current = await manager.getCurrentCastSession();
  const currentDevice = current ? await current.getCastDevice().catch(() => null) : null;
  if (current && currentDevice?.deviceId === deviceId) return current;
  if (current) await manager.endCurrentSession(true).catch(() => undefined);
  if (signal?.aborted) throw new Error("cast_aborted");

  let ok: Removable | null = null;
  let bad: Removable | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | null = null;
  const release = () => {
    ok?.remove();
    bad?.remove();
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  };
  // Executor form: the app's runtime code does not rely on `Promise.withResolvers` under Hermes.
  const started = new Promise<S>((resolve, reject) => {
    ok = manager.onSessionStarted((session) => {
      release();
      resolve(session);
    });
    bad = manager.onSessionStartFailed((_, error) => {
      release();
      reject(new Error(error));
    });
    timer = setTimeout(() => {
      release();
      reject(new Error("session_start_timeout"));
    }, timeoutMs);
    onAbort = () => {
      release();
      reject(new Error("cast_aborted"));
    };
    signal?.addEventListener("abort", onAbort);
  });
  try {
    await manager.startSession(deviceId);
  } catch (err) {
    // `started` will never settle: drop the listeners, or each failed attempt leaves two behind.
    release();
    throw err;
  }
  return started;
};

/** The part of the Cast `RemoteMediaClient` the load uses; `R` is the library's load request type. */
export type GoogleMediaClientLike<R> = {
  loadMedia: (request: R) => Promise<unknown>;
  setActiveTrackIds: (trackIds: number[]) => Promise<unknown>;
};

/**
 * Loads the cast on the device and, when it carries a subtitle, switches that track on. The request already names the track
 * in `activeTrackIds` (iOS honours it, so the subtitle shows from the first frame), but react-native-google-cast drops that
 * field on Android (`RNGCMediaLoadRequest.java` leaves it commented out), so the track is also switched on after the load.
 * A failed switch only warns: the film still plays, without the subtitle.
 */
export const loadGoogleMedia = async <R>(client: GoogleMediaClientLike<R>, request: R, subtitleTrackId: number | null): Promise<void> => {
  await client.loadMedia(request);
  if (subtitleTrackId === null) return;
  await client
    .setActiveTrackIds([subtitleTrackId])
    .catch((err) => console.warn("[cast] subtitle track not activated", JSON.stringify({ trackId: subtitleTrackId, error: String(err) })));
};
