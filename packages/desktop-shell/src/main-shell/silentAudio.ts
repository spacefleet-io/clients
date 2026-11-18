/**
 * REL-ENV-36: under SF_SILENT=1 (an agent's lane run or a test launch, never the user's own run) the app itself makes
 * Chromium silent, whoever launched it (a harness, a lane launcher, or an AppImage started by hand with only the env).
 *
 * `--mute-audio` alone is not enough: Chromium still opens one sound-server stream per output (Parrot's Web Audio
 * graph and its media-session anchor element), unmuted on the server side, and a stream whose PULSE_SINK is missing
 * plays on the default output. `--disable-audio-output` gives Chromium a fake output: Web Audio and media elements
 * keep running (time advances, `ended` fires) but no stream reaches PulseAudio/PipeWire at all.
 */

/** The Chromium switches an SF_SILENT launch appends. */
export const SILENT_CHROMIUM_SWITCHES = ["mute-audio", "disable-audio-output"] as const;

/** SF_SILENT=1 (any value but "0"/"false"/"no"), the same reading as @space/mpv `isSilentMpvEnv`. */
export const isSilentEnv = (env: Record<string, string | undefined>): boolean => {
  const raw = env.SF_SILENT?.trim().toLowerCase();
  return Boolean(raw) && raw !== "0" && raw !== "false" && raw !== "no";
};

/**
 * Appends the silent switches when the env asks for silence; call before `app.whenReady()`. Returns the switches
 * appended (none for the user's own run), for the main log.
 */
export const applySilentAudio = (
  commandLine: { appendSwitch: (name: string) => void },
  env: Record<string, string | undefined>,
): readonly string[] => {
  if (!isSilentEnv(env)) return [];
  for (const name of SILENT_CHROMIUM_SWITCHES) commandLine.appendSwitch(name);
  return SILENT_CHROMIUM_SWITCHES;
};
