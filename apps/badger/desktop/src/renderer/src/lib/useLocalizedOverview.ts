import { useTranslation } from "react-i18next";
import { isClientUiLanguage } from "@space/shared";
import { useLocalizedOverview as useSharedLocalizedOverview, type OverviewTitle } from "@space/metadata-client/react";
import { useAuth } from "@/auth";
import { getLocalizedOverview } from "@/lib/metadata";

/**
 * The title's synopsis in the interface language, else English, else the stored one (LIB-LANG-01): the shared hook of
 * `@space/metadata-client/react`, asked with the signed-in session. Titles and artwork are NOT touched here: they
 * follow the synced library-language layer.
 */
export function useLocalizedOverview(media: OverviewTitle): string | null {
  const { token } = useAuth();
  const { i18n } = useTranslation();
  const uiLanguage = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  return useSharedLocalizedOverview(
    media,
    uiLanguage,
    token ? (type, catalogId, language) => getLocalizedOverview(token, type, catalogId, language) : null
  );
}
