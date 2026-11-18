import { useMemo } from "react";
import type { LocalizedEpisodeMap } from "@space/metadata-client";
import { useLocalizedEpisodes } from "@space/metadata-client/react";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { fetchEpisodes } from "./metadata/runtime";
import { localizePlayback, localizeShowDetails, type PlaybackNames } from "./playback/localizedEpisodes";
import { useAuth } from "../store/auth";

/** A show's episode names and synopses in the interface language (LIB-LANG-01); empty for a film or until resolved. */
const useLocalizedEpisodeMap = (details: MediaDetails | null): LocalizedEpisodeMap => {
  const { token } = useAuth();
  const { i18n } = useTranslation();
  return useLocalizedEpisodes(details, i18n.language, token ? fetchEpisodes : null);
};

/**
 * The details with a show's episode names and synopses in the interface language, else English, else as stored
 * (LIB-LANG-01). Follows a language switch live.
 */
export const useLocalizedShowDetails = (details: MediaDetails | null): MediaDetails | null => {
  const localized = useLocalizedEpisodeMap(details);
  return useMemo(() => localizeShowDetails(details, localized), [details, localized]);
};

/**
 * The player's session with the episodes it names (header, next-episode card, resume prompt, OS media controls) from
 * the same source as the title page's episode list, so both always agree in every language (LIB-LANG-01).
 */
export const useLocalizedPlayback = <S extends PlaybackNames>(session: S): S => {
  const localized = useLocalizedEpisodeMap(session.details);
  const { details, episode, nextEpisode, previousEpisode } = session;
  const names = useMemo(
    () => localizePlayback({ details, episode, nextEpisode, previousEpisode }, localized),
    [details, episode, nextEpisode, previousEpisode, localized],
  );
  return localized.size === 0 ? session : { ...session, ...names };
};
