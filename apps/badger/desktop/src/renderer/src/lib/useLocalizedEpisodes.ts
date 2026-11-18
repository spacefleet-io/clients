import { useTranslation } from "react-i18next";
import { isClientUiLanguage } from "@space/shared";
import type { LocalizedEpisodeMap } from "@space/metadata-client";
import { useLocalizedEpisodes as useSharedLocalizedEpisodes, type EpisodesShow } from "@space/metadata-client/react";
import { useAuth } from "@/auth";
import { getLocalizedEpisodes } from "@/lib/metadata";

/**
 * A show's episode names and synopses in the interface language, else English (LIB-LANG-01): the shared hook of
 * `@space/metadata-client/react`, asked with the signed-in session. Keyed by `${seasonNumber}:${episodeNumber}`; render
 * sites fall back to the stored values when a key or field is missing (loading, offline, signed out).
 */
export function useLocalizedEpisodes(show: EpisodesShow): LocalizedEpisodeMap {
  const { token } = useAuth();
  const { i18n } = useTranslation();
  const uiLanguage = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  return useSharedLocalizedEpisodes(
    show,
    uiLanguage,
    token ? (tvId, language, episodeKeys) => getLocalizedEpisodes(token, tvId, language, episodeKeys) : null
  );
}
