/**
 * A track's name in the player (INGS-NAME-02): audio and subtitles alike, "Français" or "Français - SDH", the language
 * named in the UI language. Every site that names a track for mpv or matches mpv's track back to an app track goes
 * through here, so the title sent to mpv and the title looked for are always the same string.
 */
import i18next from "i18next";
import { formatTrackDisplayLabel } from "@space/shared/mediaLanguageDisplay";

export const formatPlayerTrackLabel = (
  language: string | null | undefined,
  label: string | null | undefined,
  undefinedLabel?: string,
) => formatTrackDisplayLabel(language, label, i18next.resolvedLanguage || i18next.language || "en", undefinedLabel);
