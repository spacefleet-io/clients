/**
 * REL-CD-29 / LIB-FMT-13: the "please update the plugin" state of the Jellyfin sidecar. The sidecar has no screen:
 * it reports the state on /status, the plugin logs it, writes it to the Jellyfin activity log and shows it on the
 * plugin's settings page. Wording pending Chris's approval (vault v4 plan §5).
 */
import { APP_UPDATE_REQUIRED, APP_UPDATE_REQUIRED_STATUS, type AppUpdateRequiredPayload } from "@space/shared/appVersion";

export const UPDATE_REQUIRED_MESSAGE =
  "SpaceFleet has been updated. Update the Badger plugin in Jellyfin (Dashboard > Plugins) to keep watching your library.";

/**
 * `api_refused`: the API answered 426 app_update_required (the version floor for badger/jellyfin, or a library op
 * stream this build does not read — the shared refusal payload does not keep which); `library_format_too_new`: the
 * library holds a format this build does not read (LIB-FMT-13's local "too new" check, never a server answer).
 */
export type UpdateRequiredReason = "api_refused" | "library_format_too_new";

export type IntegrationUpdateRequired = {
  reason: UpdateRequiredReason;
  /** The minimum version the API named, null when it named none. */
  minVersion: string | null;
  /** When this process was refused (ISO). */
  at: string;
  message: string;
};

export const updateRequiredState = (reason: UpdateRequiredReason, minVersion: string | null): IntegrationUpdateRequired => ({
  reason,
  minVersion: minVersion || null,
  at: new Date().toISOString(),
  message: UPDATE_REQUIRED_MESSAGE,
});

/** The state for a refusal the shared API clients reported (`onAppUpdateRequired`). */
export const updateRequiredFromPayload = (payload: AppUpdateRequiredPayload): IntegrationUpdateRequired =>
  updateRequiredState("api_refused", payload.minVersion);

/** The state for a hand-written `fetch` answered 426 `app_update_required`, or null for any other answer. */
export const updateRequiredFromResponse = (status: number, body: unknown): IntegrationUpdateRequired | null => {
  if (status !== APP_UPDATE_REQUIRED_STATUS || !body || typeof body !== "object") return null;
  if (!("error" in body) || body.error !== APP_UPDATE_REQUIRED) return null;
  const minVersion = "minVersion" in body && typeof body.minVersion === "string" ? body.minVersion : null;
  return updateRequiredState("api_refused", minVersion);
};
