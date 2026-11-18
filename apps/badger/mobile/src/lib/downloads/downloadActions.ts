/**
 * User-facing download operations: plan → decide (space / Wi-Fi) → resolve the
 * storage gateway per placement → hand each file to the native queue.
 */
import { PermissionsAndroid, Platform } from "react-native";
import type { MediaDetails } from "@space/shared/libraryTypes";
import type { OfflineQualityChoice } from "@space/shared/offlineQualityChoice";
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";
import { getAppSettings } from "../appSettings";
import { scopeLogger } from "@space/mobile-shell/logger";
import { translate } from "@space/mobile-shell/i18n";
import { resolveGatewayCandidates } from "../playbackGateway";
import { decideStart, pendingDownloadBytes, type StartDecision } from "./decisions";
import { getDownloadsState } from "./downloadsStore";
import { nativeEnqueue, nativeGetStatus, nativeRemove, nativeRetry } from "@space/mobile-media-proxy/downloads";
import { planScope, scopeQualityChoices, type SkipReason } from "./planner";
import type { OfflineScope } from "./scope";

const log = scopeLogger("downloads");

export type StartDownloadResult =
  | { kind: "cancelled" }
  | { kind: "enqueued"; count: number; estimatedBytes: number; waitForWifi: boolean; skipped: number }
  | { kind: "nothing"; reason: SkipReason }
  | { kind: "refused"; refusal: Extract<StartDecision, { action: "refuse" }> }
  | { kind: "error"; reason: "details_missing" }
  | { kind: "error"; reason: "failed"; detail: string };

/** Android 13+ needs a runtime grant for the progress notification; best effort. */
const ensureNotificationPermission = async (): Promise<void> => {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  try {
    await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS" as never);
  } catch (err) {
    log.warn("notification_permission.failed", { error: String(err) });
  }
};

/** The shared bridge throws a code when the native module is missing; the user reads the sentence. */
const errorDetail = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message === "DOWNLOADS_NATIVE_UNAVAILABLE" ? translate("downloads.errors.nativeUnavailable") : message;
};

/**
 * Start the download of one or more scopes of a title (a movie, an episode,
 * a season, or the seasons ticked in the picker). When the files have more
 * than one quality, `chooseQuality` asks the user once for the whole request
 * (OFFL-QUAL-01); null = the user dismissed the prompt, nothing starts.
 */
export const startDownload = async (input: {
  /** Scope source: may come from `getMediaDetails(id, { chunks: false })` (no segment lists), so it is never planned from. */
  details: MediaDetails;
  scopes: readonly OfflineScope[];
  token: string;
  /** Re-reads the title WITH the per-segment rows the planner needs (init + chunk keys of the chosen format). */
  loadFullDetails: (mediaId: string) => Promise<MediaDetails | null>;
  /** The download quality prompt; resolves the picked quality, or null when dismissed. */
  chooseQuality: (choices: OfflineQualityChoice[]) => Promise<string | null>;
}): Promise<StartDownloadResult> => {
  const { scopes, token } = input;
  const settings = getAppSettings();
  let details: MediaDetails | null;
  try {
    details = await input.loadFullDetails(input.details.id);
  } catch (err) {
    log.error("start.details_failed", { mediaId: input.details.id, error: String(err) });
    return { kind: "error", reason: "failed", detail: errorDetail(err) };
  }
  if (!details) {
    log.error("start.details_missing", { mediaId: input.details.id });
    return { kind: "error", reason: "details_missing" };
  }
  const existing = getDownloadsState().items;
  const { choices, prompt } = scopeQualityChoices(details, scopes, existing);
  log.info("start.quality_choices", {
    mediaId: details.id,
    prompt,
    choices: choices.map((c) => ({ quality: c.quality, totalBytes: c.totalBytes, fallbacks: c.fallbacks })),
  });
  let quality: string | null = choices[0]?.quality ?? null;
  if (prompt) {
    quality = await input.chooseQuality(choices);
    log.info("start.quality_chosen", { mediaId: details.id, quality });
    if (!quality) return { kind: "cancelled" };
  }
  // No usable quality anywhere: plan anyway so every file reports its skip reason.
  const plan = planScope(details, scopes, quality ?? "0p", existing);
  log.info("start.plan", {
    mediaId: details.id,
    scopes: scopes.map((s) => s.kind),
    items: plan.items.length,
    skipped: plan.skipped.length,
    estimatedBytes: plan.totalEstimatedBytes,
    quality,
  });

  if (plan.items.length === 0) {
    return { kind: "nothing", reason: plan.skipped[0]?.reason ?? "no-file" };
  }

  try {
    const status = await nativeGetStatus();
    const decision = decideStart({
      estimatedBytes: plan.totalEstimatedBytes,
      pendingBytes: pendingDownloadBytes(getDownloadsState().items),
      freeBytes: status.freeBytes,
      wifiOnly: settings.downloadsWifiOnly,
      networkType: status.networkType,
    });
    log.info("start.decision", { ...decision, networkType: status.networkType, freeBytes: status.freeBytes });
    if (decision.action === "refuse") {
      return { kind: "refused", refusal: decision };
    }

    await ensureNotificationPermission();

    // One gateway resolution per placement (silo); episodes of a season usually share none.
    const gatewayByPlacement = new Map<string | null, Promise<string[]>>();
    const gatewaysFor = (placementId: string | null) => {
      let pending = gatewayByPlacement.get(placementId);
      if (!pending) {
        pending = resolveGatewayCandidates(token, placementId);
        gatewayByPlacement.set(placementId, pending);
      }
      return pending;
    };

    for (const planned of plan.items) {
      const placementId =
        planned.spec.objects
          .map(([key]) => parseMediaPlacementIdFromObjectKey(key))
          .find((id): id is string => Boolean(id)) ?? null;
      const gatewayCandidates = await gatewaysFor(placementId);
      await nativeEnqueue({ ...planned.spec, gatewayCandidates });
    }

    return {
      kind: "enqueued",
      count: plan.items.length,
      estimatedBytes: plan.totalEstimatedBytes,
      waitForWifi: decision.waitForWifi,
      skipped: plan.skipped.length,
    };
  } catch (err) {
    log.error("start.failed", { error: String(err) });
    return { kind: "error", reason: "failed", detail: errorDetail(err) };
  }
};

/** Re-queue failed downloads (native keeps the object list; auth is re-configured at app start). */
export const retryDownloads = async (ids: string[]): Promise<void> => {
  for (const id of ids) await nativeRetry(id, null);
};

/** Cancel (if running) and delete downloads and their files. */
export const removeDownloads = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  log.info("remove", { count: ids.length });
  await nativeRemove(ids);
};
