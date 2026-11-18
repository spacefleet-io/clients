import { DEFAULT_ACCOUNT_LANGUAGE, isClientUiLanguage, pickStartLanguage, type ClientUiLanguage } from "@space/shared";
import { isAudioLanguageChoice, type AudioLanguageChoice } from "@space/shared/profileSettings";
import { isTitleLanguage, type TitleLanguage } from "@space/shared/titleLanguage";
import { normalizeLanguageCode } from "@space/shared/trackPrefs";
import { readJson, writeJson } from "./storage";
import { DEFAULT_TRANSCODE_OUTPUTS } from "../../../shared/labQueueShared";
import {
  QUALITY_ORDER,
  defaultCodecForQuality,
  type CodecPreset,
  type QualityPreset,
} from "../../../shared/quality";
import { coerceLaneCap, coerceWatchedDirectories, type WatchedDirectory } from "../../../shared/deviceCapacity";

export type SkipMode = "auto" | "manual";
export type { QualityPreset, CodecPreset };

const CONFIG_CHANGED_EVENT = "sf_client_config_changed";

export type { WatchedDirectory };

export type TranscodeOutput = {
  quality: QualityPreset;
  codec: CodecPreset;
};

export type UiMode = "dark";
// Only the Space theme ships, dark-only. Light mode was removed on
// 2026-05-25. Historic presets
// (catppuccin, nord, dracula, monokai, netflix, github) had already been
// removed on 2026-04-11.
export type UiTheme = "space";

export type TrailerProvider = "youtube" | "invidious";

export type TrailerSource = {
  provider: TrailerProvider;
  invidiousUrl: string;
  validated: boolean;
};

export type TrailerLanguages = {
  extras: string[];
};

export { QUALITY_ORDER, defaultCodecForQuality };

export type ClientConfig = {
  configured: boolean;
  playbackQuality: QualityPreset;
  /**
   * When true, playback locks to the user's chosen quality and the
   * adaptive-bitrate (ABR) controller observes only — it surfaces a warning
   * toast when bandwidth is insufficient instead of auto-downshifting.
   * Default false: ABR is allowed to step down (and back up toward the
   * preferred quality) as network conditions change.
   */
  forcePlaybackQuality: boolean;
  transcodeOutputs: TranscodeOutput[];
  enableCodecSelection: boolean;
  maxParallelTranscodes: number;
  /**
   * Caps how many CPU-heavy source extractions (probe/identify/extract/commit)
   * the V2 ingest engine runs in parallel — the `source` lane cap. Distinct
   * from `maxParallelTranscodes`, which caps the `format` (transcode) lane.
   * Range 1-3, default 1.
   */
  maxParallelExtractions: number;
  enableWatchDirectories: boolean;
  enableMetadataTools: boolean;
  uiLanguage: ClientUiLanguage;
  uiMode: UiMode;
  uiTheme: UiTheme;
  trailerSource: TrailerSource;
  trailerLanguages: TrailerLanguages;
  autoplayNextEpisode: boolean;
  introSkipEnabled: boolean;
  creditsSkipEnabled: boolean;
  skipMode: SkipMode;
  /**
   * "Default audio language" (PLAY-TRACK-01, PLAY-TRACK-04): the ISO 639-1 code audio starts in when the title has
   * no remembered choice and the file has that language. `null` = Original: the file's own default track.
   * Belongs to the profile (ACCT-SQUAD-03), shared with phone and TV as `audioLanguage`.
   */
  defaultAudioLanguage: AudioLanguageChoice | null;
  /**
   * "Subtitle language" (ACCT-SQUAD-03, PLAY-TRACK-04): the ISO 639-1 code subtitles start in when the title has no
   * remembered subtitle choice and the file has that language. `null` = no preference: the file's own default
   * subtitle. Belongs to the profile, shared with phone and TV as `subtitleLanguage`.
   */
  defaultSubtitleLanguage: AudioLanguageChoice | null;
  /**
   * How titles, posters and backdrops appear (ACCT-PROF-03): "app" (the account's language) or "original". Belongs to
   * the profile (ACCT-SQUAD-03), shared with phone and TV as `titleLanguage`; null for a profile that never answered
   * (reads as "app", `profileTitleLanguage`). Never seeded from the account or this computer.
   */
  titleLanguage: TitleLanguage | null;
  watchedDirectories: WatchedDirectory[];
  /**
   * Feature flag — when true (default), the renderer ingest UI consumes the
   * new `runtime.jobs.v2` WebSocket stream instead of the legacy lab-queue
   * IPC. Set to false in localStorage to roll back to the legacy path.
   * Plan §8/§9.
   */
  runtimeEngineV2Enabled: boolean;
  /**
   * Automatic desktop updates (REL-UPD-01). Default **true**: the main-process updater checks at start and every 6h,
   * downloads a new version in the background and installs it when the app quits (or on "Restart now"). Off: the user
   * checks, downloads and restarts from Settings. A mandatory update is offered either way.
   */
  autoUpdate: boolean;
  /**
   * True once the user flipped the automatic-updates switch themselves. Builds before REL-UPD-01 stored the old
   * default (`autoUpdate: false`) with every settings save, so a stored `false` only counts as a choice with this set.
   */
  autoUpdateChosen: boolean;
  /**
   * Output container for offline downloads. Default `"mkv"` — MKV is lossless
   * for all subtitle codecs (PGS / ASS / SRT / VTT) and the recommended
   * default. `"mp4"` is supported for users who prefer MP4 portability, but
   * ASS / PGS subtitle tracks get dropped (recorded in the job log) since
   * MP4 cannot embed them without lossy conversion. The confirm modal warns
   * about the skipped tracks when MP4 is selected. Phase 3 of the
   * offline-mode plan (Layer C.5). This computer's setting (OFFL-FILE-01): kept in
   * `device-settings.json`, never in the synced `client_config_v1` (lib/profileClientConfig.ts).
   */
  offlineExportFormat: "mkv" | "mp4";
};

const CONFIG_KEY = "sf_client_config_v1";

export const defaultClientConfig: ClientConfig = {
  configured: true,
  playbackQuality: "1080p",
  forcePlaybackQuality: false,
  transcodeOutputs: DEFAULT_TRANSCODE_OUTPUTS,
  enableCodecSelection: false,
  maxParallelTranscodes: 1,
  maxParallelExtractions: 1,
  enableWatchDirectories: false,
  enableMetadataTools: false,
  uiLanguage: "en",
  uiMode: "dark",
  uiTheme: "space",
  trailerSource: { provider: "youtube", invidiousUrl: "", validated: false },
  trailerLanguages: { extras: [] },
  autoplayNextEpisode: true,
  introSkipEnabled: true,
  creditsSkipEnabled: true,
  skipMode: "auto",
  defaultAudioLanguage: null,
  defaultSubtitleLanguage: null,
  titleLanguage: null,
  watchedDirectories: [],
  runtimeEngineV2Enabled: true,
  autoUpdate: true,
  autoUpdateChosen: false,
  offlineExportFormat: "mkv",
};

export const isQualityPreset = (value: unknown): value is QualityPreset =>
  value === "2160p" ||
  value === "1080p" ||
  value === "720p" ||
  value === "480p" ||
  value === "360p" ||
  value === "240p" ||
  value === "144p";

const isCodecPreset = (value: unknown): value is CodecPreset =>
  value === "h264" || value === "hevc";

const isUiMode = (value: unknown): value is UiMode => value === "dark";

const isUiTheme = (value: unknown): value is UiTheme => value === "space";

const isTrailerProvider = (value: unknown): value is TrailerProvider =>
  value === "youtube" || value === "invidious";

/** A stored language setting: a code from `AUDIO_LANGUAGE_CHOICES` (any ISO form), else no preference (null). */
export const coerceLanguageChoice = (value: unknown): AudioLanguageChoice | null => {
  if (typeof value !== "string") return null;
  const code = normalizeLanguageCode(value);
  return isAudioLanguageChoice(code) ? code : null;
};

/**
 * Language of a first start (UX-I18N-01): the first of the OS languages Chromium reports that is one of the four app
 * languages, else English. Once a language is saved in the config it is the remembered choice and wins.
 */
export const deviceUiLanguage = (): ClientUiLanguage =>
  pickStartLanguage(
    null,
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language],
    isClientUiLanguage,
    DEFAULT_ACCOUNT_LANGUAGE,
  );

const normalizeClientConfig = (stored: Record<string, unknown> | null): ClientConfig => {
  if (!stored || typeof stored !== "object") return { ...defaultClientConfig, uiLanguage: deviceUiLanguage() };

  const legacyPreferredQuality = (stored as any).preferredQuality;

  const merged: ClientConfig = {
    ...defaultClientConfig,
    ...(stored as Partial<ClientConfig>),
  };

  if (!isQualityPreset(merged.playbackQuality) && isQualityPreset(legacyPreferredQuality)) {
    merged.playbackQuality = legacyPreferredQuality;
  }

  const outputsRaw = (stored as any).transcodeOutputs;
  const outputs: TranscodeOutput[] = Array.isArray(outputsRaw)
    ? outputsRaw.flatMap((entry) => {
        const quality = entry?.quality;
        const codec = entry?.codec;
        if (!isQualityPreset(quality)) return [];
        if (codec === "both") return [{ quality, codec: "h264" }, { quality, codec: "hevc" }];
        if (isCodecPreset(codec)) return [{ quality, codec }];
        return [];
      })
    : [];

  if (outputs.length === 0) {
    merged.transcodeOutputs = defaultClientConfig.transcodeOutputs.slice();
  } else {
    const dedup = new Map<string, TranscodeOutput>();
    outputs.forEach((output) => {
      dedup.set(`${output.quality}:${output.codec}`, output);
    });
    merged.transcodeOutputs = Array.from(dedup.values());
  }

  merged.enableCodecSelection = Boolean((stored as any).enableCodecSelection);
  merged.maxParallelTranscodes = coerceLaneCap((stored as any).maxParallelTranscodes);
  merged.maxParallelExtractions = coerceLaneCap((stored as any).maxParallelExtractions);
  merged.watchedDirectories = coerceWatchedDirectories((stored as any).watchedDirectories);
  merged.enableWatchDirectories = Boolean((stored as any).enableWatchDirectories);
  merged.enableMetadataTools = Boolean((stored as any).enableMetadataTools);
  merged.forcePlaybackQuality = Boolean((stored as any).forcePlaybackQuality);
  // META-DIRECT-03: the own-key ("direct") mode was removed. A config saved before carries
  // `metadataAccess` (mode + apiKey); drop it silently so that user falls back to the ticket path.
  Reflect.deleteProperty(merged, "metadataAccess");

  if (!merged.trailerSource) {
    merged.trailerSource = { ...defaultClientConfig.trailerSource };
  }
  if (!isTrailerProvider(merged.trailerSource.provider)) {
    merged.trailerSource.provider = defaultClientConfig.trailerSource.provider;
  }
  merged.trailerSource.invidiousUrl =
    typeof merged.trailerSource.invidiousUrl === "string" ? merged.trailerSource.invidiousUrl : "";
  merged.trailerSource.validated = Boolean(merged.trailerSource.validated);

  if (!merged.trailerLanguages) {
    merged.trailerLanguages = { ...defaultClientConfig.trailerLanguages };
  }
  if (!Array.isArray(merged.trailerLanguages.extras)) {
    merged.trailerLanguages.extras = [];
  }
  merged.trailerLanguages.extras = merged.trailerLanguages.extras
    .filter((value) => typeof value === "string" && value)
    .slice(0, 2);

  if (!isUiMode(merged.uiMode)) {
    merged.uiMode = defaultClientConfig.uiMode;
  }
  if (!isUiTheme(merged.uiTheme)) {
    merged.uiTheme = defaultClientConfig.uiTheme;
  }
  if (merged.uiTheme !== "space") {
    merged.uiTheme = "space";
  }
  if (!isClientUiLanguage(merged.uiLanguage)) {
    merged.uiLanguage = deviceUiLanguage();
  }
  merged.defaultAudioLanguage = coerceLanguageChoice(stored.defaultAudioLanguage);
  merged.defaultSubtitleLanguage = coerceLanguageChoice(stored.defaultSubtitleLanguage);
  merged.titleLanguage = isTitleLanguage(stored.titleLanguage) ? stored.titleLanguage : null;

  // V2 ingest is the default. Existing users without the key in their stored
  // config get true via the spread of defaultClientConfig above; only an
  // explicit `false` in storage rolls them back to the legacy path.
  merged.runtimeEngineV2Enabled =
    typeof (stored as any).runtimeEngineV2Enabled === "boolean"
      ? (stored as any).runtimeEngineV2Enabled
      : defaultClientConfig.runtimeEngineV2Enabled;
  // Automatic updates default ON (REL-UPD-01). Only the user's own switch turns them off: a stored `false` without
  // `autoUpdateChosen` is the old off-by-default value every settings save wrote, not a choice.
  merged.autoUpdateChosen = (stored as any).autoUpdateChosen === true;
  merged.autoUpdate = merged.autoUpdateChosen ? (stored as any).autoUpdate !== false : true;
  // Offline export format: "mkv" (default) or "mp4". Anything else falls
  // back to MKV — including older stored configs that lack the field, which
  // already pick MKV via the defaultClientConfig spread above.
  const storedOfflineExportFormat = (stored as any).offlineExportFormat;
  merged.offlineExportFormat =
    storedOfflineExportFormat === "mp4" ? "mp4" : "mkv";

  return merged;
};

export const coerceClientConfig = (stored: unknown): ClientConfig => {
  if (!stored || typeof stored !== "object") return defaultClientConfig;
  return normalizeClientConfig(stored as Record<string, unknown>);
};

export function loadClientConfig(): ClientConfig {
  const stored = readJson<any>(CONFIG_KEY, null);
  const config = normalizeClientConfig(stored);
  if (stored && typeof stored === "object" && "metadataAccess" in stored) {
    // META-DIRECT-03 migration: persist the config without the removed own-key setting (and its key), once.
    console.info("[config] dropped the removed own-key setting (META-DIRECT-03)");
    writeJson(CONFIG_KEY, config);
  }
  return config;
}

export function saveClientConfig(next: ClientConfig) {
  writeJson(CONFIG_KEY, next);
  window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT, { detail: next }));
}

let cachedSnapshotRaw: string | null | undefined = undefined;
let cachedSnapshotValue: ClientConfig = defaultClientConfig;

export function getClientConfigSnapshot(): ClientConfig {
  const raw = window.localStorage.getItem(CONFIG_KEY);
  if (raw === cachedSnapshotRaw) return cachedSnapshotValue;
  cachedSnapshotRaw = raw;
  if (!raw) {
    cachedSnapshotValue = defaultClientConfig;
    return cachedSnapshotValue;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    cachedSnapshotValue = normalizeClientConfig(parsed);
    return cachedSnapshotValue;
  } catch {
    cachedSnapshotValue = defaultClientConfig;
    return cachedSnapshotValue;
  }
}

export function subscribeClientConfig(callback: () => void) {
  const onChanged = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONFIG_KEY) callback();
  };

  window.addEventListener(CONFIG_CHANGED_EVENT, onChanged);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged);
    window.removeEventListener("storage", onStorage);
  };
}
