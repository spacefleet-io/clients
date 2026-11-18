/**
 * PLAY-OSMEDIA-01 item 4 (phone): next or previous pressed on the lock screen, the notification card or a headset while
 * the app is in the background gives the player a new `source` prop, but React Native holds view prop updates until the
 * app's window shows again, so mpv kept the old episode, paused. While the app is not in front, the new source goes to
 * the native player through the module (`MpvControl.loadInBackground`, Android) at once; the view skips the held prop
 * when it finally arrives.
 */

export type BackgroundSourceLoader = {
  loadInBackground?: (url: string, options: string | null) => Promise<boolean>;
};

export type BackgroundSourceInput = {
  source: string | null | undefined;
  startOptions: string | null | undefined;
  /** React Native `AppState.currentState`. */
  appState: string | null | undefined;
  platformOs: string;
  isTv: boolean;
};

/** Whether this source change must go through the module: Android phone, app not in front, a source to load. */
export const loadsSourceInBackground = (input: BackgroundSourceInput): boolean =>
  input.platformOs === "android" && !input.isTv && input.appState !== "active" && typeof input.source === "string" && input.source.length > 0;

/**
 * Hands `input.source` to the native player when [loadsSourceInBackground] says so. Resolves to what the native side did:
 * `loaded`, `skipped` (already loaded, or no player view), `foreground` (the prop path loads it), `unsupported` (no native
 * method: iPhone) or `failed`.
 */
export const loadSourceInBackground = async (
  player: BackgroundSourceLoader,
  input: BackgroundSourceInput,
  log: (event: string, detail: string) => void = (event, detail) => console.info(event, detail),
): Promise<"loaded" | "skipped" | "foreground" | "unsupported" | "failed"> => {
  if (!loadsSourceInBackground(input)) return "foreground";
  const detail = { source: input.source, startOptions: input.startOptions ?? null, appState: input.appState ?? null };
  if (typeof player.loadInBackground !== "function") {
    log("playback.background_load.unsupported", JSON.stringify(detail));
    return "unsupported";
  }
  try {
    const loaded = await player.loadInBackground(input.source as string, input.startOptions ?? null);
    log(loaded ? "playback.background_load.loaded" : "playback.background_load.skipped", JSON.stringify(detail));
    return loaded ? "loaded" : "skipped";
  } catch (error) {
    log("playback.background_load.failed", JSON.stringify({ ...detail, error: String(error) }));
    return "failed";
  }
};

export type CoreHolder = {
  holdCoreForSwitch?: () => Promise<boolean>;
};

/**
 * Runs `switchNow` (the episode switch that remounts the player). Android phone, app not in front: React Native drops
 * the old player view at once but holds the new one until the window shows again, so the native side is told first
 * (`MpvControl.holdCoreForSwitch`) and keeps the old core to play the next episode through [loadSourceInBackground].
 */
export const switchEpisodeKeepingCore = async (
  player: CoreHolder,
  input: Pick<BackgroundSourceInput, "appState" | "platformOs" | "isTv">,
  switchNow: () => void,
): Promise<void> => {
  const hidden = input.platformOs === "android" && !input.isTv && input.appState !== "active";
  if (hidden && typeof player.holdCoreForSwitch === "function") {
    await player.holdCoreForSwitch().catch((error: unknown) => console.warn("playback.episode.switch.hold_failed", String(error)));
  }
  switchNow();
};
