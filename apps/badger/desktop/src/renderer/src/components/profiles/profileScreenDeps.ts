import { useTranslation } from "react-i18next";
import type { ProfilesScreenDeps } from "@space/ui/profiles";
import { deleteProfileOnThisDevice, profileStore } from "@/lib/profileStore";
import { rendererLogger } from "@/logger";

const logger = rendererLogger.child({ scope: "profiles-screens" });
const log = (event: string, data: Record<string, unknown>) => logger.info(data, event);

/** The desktop's store, delete (with the library data move), log and words for the shared profile screens. */
export const useProfileScreenDeps = (): ProfilesScreenDeps => {
  const { t } = useTranslation();
  return { store: profileStore, deleteProfile: deleteProfileOnThisDevice, log, t };
};
