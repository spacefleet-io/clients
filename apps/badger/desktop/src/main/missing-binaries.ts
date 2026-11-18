// Startup check for the bundled binaries (MPV-BIN-01). A missing binary is
// reported in the app logs only — never a modal, never a quit — so agents,
// headless runs and humans all see the same signal and startup carries on.

/** One bundle (ffmpeg + ffprobe + mpv + their libraries) per OS: scripts/fetch-deps.ts. */
export const SETUP_BINARIES_COMMAND = "bun run setup:binaries";

export const MISSING_BINARIES_MESSAGE =
  `missing required bundled binaries — run \`${SETUP_BINARIES_COMMAND}\` from the repo root`;

export interface MissingBinariesReport {
  missingBinaries: string[];
  commands: string[];
}

export function missingBinariesReport(input: {
  ffmpegPath: string | undefined;
  ffprobePath: string | undefined;
  /** `resolveExternalMpvTarget().kind`; "fallback" means no bundled mpv and no override. */
  mpvKind: string;
}): MissingBinariesReport | null {
  const missingBinaries: string[] = [];
  if (!input.ffmpegPath) missingBinaries.push("ffmpeg");
  if (!input.ffprobePath) missingBinaries.push("ffprobe");
  if (input.mpvKind === "fallback") missingBinaries.push("mpv");
  if (missingBinaries.length === 0) return null;
  return { missingBinaries, commands: [SETUP_BINARIES_COMMAND] };
}
