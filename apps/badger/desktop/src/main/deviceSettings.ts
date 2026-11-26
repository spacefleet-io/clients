/**
 * Device-local settings: values that belong to THIS computer, not to the
 * account. Stored in `<userData>/device-settings.json`, so they survive logout,
 * account switches and `resetClientStorage` (which wipes renderer localStorage)
 * and never flow into the synced library DB.
 *
 * These values live here:
 *  - whether ingest makes the one fallback 360p copy (#25, Chris 2026-10-09, reworked 2026-10-13);
 *  - what uploads do while a video plays: full / throttle / pause (#25, Chris 2026-10-13);
 *  - the capacity settings: parallel transcodes, parallel extractions and watched folders (ACCT-SQUAD-03,
 *    Chris 2026-10-30), and the download file format (OFFL-FILE-01). They were in the synced `client_config_v1`
 *    before; the renderer copies this computer's values here once (`adoptCapacity`) and from then on reads and
 *    writes them here only. A file stored before the download format moved here takes that format once the same way.
 * On the first start of a computer the hardware is detected ONCE and turned into
 * recommendations; the renderer then asks the user once (the "First setup" flow, FirstSetup.tsx).
 * Until answered, the recommendation applies. Nothing re-detects or overrides a
 * stored value. A computer that answered the fallback-copy question before the uploads
 * question existed is asked the uploads one once, from the hardware it stored. A file an
 * older build wrote with `transcode.auto480p` is read as `fallbackCopy` (same answer) and rewritten.
 *
 * No Electron import here: the file path and the hardware probe are injected so
 * the store is unit-testable (tests/device-transcode-settings.test.ts).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decideFallbackCopy,
  decideUploadsDuringPlayback,
  fallbackCopyReason,
  uploadsDuringPlaybackReason,
  type TranscodeHardware,
} from "@space/shared/transcodeHardware";
import { fallbackCopyForAnswer, formatTranscodeDefaultLog, type FallbackCopyAnswer, type DeviceTranscodeSettings } from "../shared/transcodeDefault";
import {
  formatUploadsDefaultLog,
  isUploadsDuringPlayback,
  uploadsDuringPlaybackForAnswer,
  type DeviceUploadsDuringPlaybackSettings,
  type UploadsDuringPlayback,
  type UploadsDuringPlaybackAnswer,
  type UploadsFirstRunAnswer,
} from "../shared/uploadPlaybackDefault";
import {
  coerceDeviceCapacity,
  isOfflineExportFormat,
  isStoredDeviceCapacity,
  type DeviceCapacitySettings,
  type DeviceCapacityValues,
  type StoredDeviceCapacity,
} from "../shared/deviceCapacity";

/** What the First setup flow sends for the fallback-copy question: agree with the recommendation, or take the opposite. */
export type FirstRunAnswer = Extract<FallbackCopyAnswer, "accepted" | "overridden">;

type DeviceSettingsFile = {
  version: 1;
  transcode?: DeviceTranscodeSettings;
  uploadsDuringPlayback?: DeviceUploadsDuringPlaybackSettings;
  capacity?: StoredDeviceCapacity;
};

export type DeviceSettingsStoreOptions = {
  filePath: string;
  probeHardware: () => Promise<TranscodeHardware>;
  /**
   * `SF_TRANSCODE_FALLBACK_COPY=on|off`: test harnesses (Playwright e2e, ultimate)
   * launch with fresh userData every time; this settles a fresh computer
   * without probing ffmpeg or showing the first-run question. A stored value
   * still wins.
   */
  forcedDefault: "on" | "off" | null;
  /**
   * `SF_UPLOADS_DURING_PLAYBACK=full|throttle|pause`: same idea for the
   * uploads-while-a-video-plays question. A stored value still wins.
   */
  forcedUploadsDuringPlayback?: UploadsDuringPlayback | null;
  log: (line: string) => void;
};

export type DeviceSettingsStore = {
  /** This computer's value; runs first-start detection once if none is stored. */
  getTranscode: () => Promise<DeviceTranscodeSettings>;
  /** Record the first-run answer. Ignored (logged) once already answered. */
  answerFirstRun: (answer: FirstRunAnswer) => Promise<DeviceTranscodeSettings>;
  /** Settings → Transcoding toggle. Counts as answered. */
  setFallbackCopy: (value: boolean) => Promise<DeviceTranscodeSettings>;
  /** This computer's "uploads while a video plays" value; derives it once if none is stored. */
  getUploadsDuringPlayback: () => Promise<DeviceUploadsDuringPlaybackSettings>;
  /** True when getUploadsDuringPlayback() would run the first-start hardware detection (nothing stored or forced). */
  uploadsDuringPlaybackNeedsDetection: () => boolean;
  /** Record the first-run answer. Ignored (logged) once already answered. */
  answerUploadsFirstRun: (answer: UploadsFirstRunAnswer) => Promise<DeviceUploadsDuringPlaybackSettings>;
  /** Settings → Transcoding choice. Counts as answered. Throws on an unknown value. */
  setUploadsDuringPlayback: (value: UploadsDuringPlayback) => Promise<DeviceUploadsDuringPlaybackSettings>;
  /** Called whenever the effective value changes (first-run choice or Settings), so enforcement is live. Returns an unsubscribe. */
  onUploadsDuringPlaybackChange: (listener: (settings: DeviceUploadsDuringPlaybackSettings) => void) => () => void;
  /** This computer's capacity settings, or null before they were taken from the synced config. */
  getCapacity: () => StoredDeviceCapacity | null;
  /**
   * The one-time copy: stores `seed` (the values the synced config held) unless this computer already has values;
   * a stored entry without a download format takes `seed`'s format once.
   */
  adoptCapacity: (seed: DeviceCapacityValues) => DeviceCapacitySettings;
  /** Settings → Transcoding change. Values out of range are clamped. */
  setCapacity: (values: DeviceCapacityValues) => DeviceCapacitySettings;
};

const onOff = (value: boolean) => (value ? "on" : "off");

export const parseForcedFallbackCopy = (raw: string | undefined): "on" | "off" | null => {
  const value = raw?.trim().toLowerCase();
  return value === "on" || value === "off" ? value : null;
};

export const parseForcedUploadsDuringPlayback = (raw: string | undefined): UploadsDuringPlayback | null => {
  const value = raw?.trim().toLowerCase();
  return isUploadsDuringPlayback(value) ? value : null;
};

const UPLOADS_ANSWERS: ReadonlySet<unknown> = new Set<UploadsDuringPlaybackAnswer>([
  "accepted",
  "chosen",
  "dismissed",
  "settings",
  "forced",
]);

const isDeviceUploadsSettings = (value: unknown): value is DeviceUploadsDuringPlaybackSettings => {
  if (!value || typeof value !== "object") return false;
  if (!("mode" in value) || !isUploadsDuringPlayback(value.mode)) return false;
  if (!("answered" in value) || typeof value.answered !== "boolean") return false;
  if (!("answer" in value) || (value.answer !== null && !UPLOADS_ANSWERS.has(value.answer))) return false;
  if (!("recommendation" in value)) return false;
  const rec = value.recommendation;
  return typeof rec === "object" && rec !== null && "mode" in rec && isUploadsDuringPlayback(rec.mode);
};

const ANSWERS: ReadonlySet<unknown> = new Set<FallbackCopyAnswer>(["accepted", "overridden", "dismissed", "settings", "forced"]);

/** Shape check for the persisted blob (no zod in the desktop package). */
const isDeviceTranscodeSettings = (value: unknown): value is DeviceTranscodeSettings => {
  if (!value || typeof value !== "object") return false;
  if (!("fallbackCopy" in value) || typeof value.fallbackCopy !== "boolean") return false;
  if (!("answered" in value) || typeof value.answered !== "boolean") return false;
  if (!("answer" in value) || (value.answer !== null && !ANSWERS.has(value.answer))) return false;
  if (!("recommendation" in value)) return false;
  const rec = value.recommendation;
  return typeof rec === "object" && rec !== null && "fallbackCopy" in rec && typeof rec.fallbackCopy === "boolean";
};

/**
 * A `transcode` block an older build wrote when the copy was the 480p one:
 * `auto480p` instead of `fallbackCopy`, in the value and in its recommendation.
 * Returns the same record under the new name, or null when it is not that shape.
 */
const legacyTranscode = (value: unknown): DeviceTranscodeSettings | null => {
  if (!value || typeof value !== "object" || !("auto480p" in value) || typeof value.auto480p !== "boolean") return null;
  if (!("answered" in value) || typeof value.answered !== "boolean") return null;
  if (!("answer" in value) || (value.answer !== null && !ANSWERS.has(value.answer))) return null;
  if (!("recommendation" in value)) return null;
  const rec = value.recommendation;
  if (typeof rec !== "object" || rec === null || !("auto480p" in rec) || typeof rec.auto480p !== "boolean") return null;
  const { auto480p: _value, ...rest } = value;
  const { auto480p: recommended, ...recRest } = rec;
  const migrated = { ...rest, fallbackCopy: value.auto480p, recommendation: { ...recRest, fallbackCopy: recommended } };
  return isDeviceTranscodeSettings(migrated) ? migrated : null;
};

export const createDeviceSettingsStore = (opts: DeviceSettingsStoreOptions): DeviceSettingsStore => {
  const { filePath, log } = opts;
  let current: DeviceTranscodeSettings | null = null;
  let loading: Promise<DeviceTranscodeSettings> | null = null;
  let currentUploads: DeviceUploadsDuringPlaybackSettings | null = null;
  let loadingUploads: Promise<DeviceUploadsDuringPlaybackSettings> | null = null;
  const uploadsListeners = new Set<(settings: DeviceUploadsDuringPlaybackSettings) => void>();

  const readFile = (): DeviceSettingsFile | null => {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 1) {
        const file: DeviceSettingsFile = { version: 1 };
        let migrated = false;
        const transcode = "transcode" in parsed ? parsed.transcode : undefined;
        const legacy = legacyTranscode(transcode);
        if (isDeviceTranscodeSettings(transcode)) {
          file.transcode = transcode;
        } else if (legacy) {
          file.transcode = legacy;
          migrated = true;
          log(
            `[transcode-default] ${filePath} stored the 360p copy as auto480p=${onOff(legacy.fallbackCopy)} answered=${legacy.answered} answer=${
              legacy.answer ?? "none"
            } — carried over as fallbackCopy, detection skipped`,
          );
        } else if (transcode !== undefined) {
          log(`[transcode-default] ${filePath} transcode entry malformed (${JSON.stringify(transcode)}) — treating this computer as fresh`);
        }
        const uploads = "uploadsDuringPlayback" in parsed ? parsed.uploadsDuringPlayback : undefined;
        if (isDeviceUploadsSettings(uploads)) {
          file.uploadsDuringPlayback = uploads;
        } else if (uploads !== undefined) {
          log(
            `[uploads-playback-default] ${filePath} uploadsDuringPlayback entry malformed (${JSON.stringify(uploads)}) — asking again`,
          );
        }
        const capacity = "capacity" in parsed ? parsed.capacity : undefined;
        if (isStoredDeviceCapacity(capacity)) {
          const { offlineExportFormat, ...values } = coerceDeviceCapacity(capacity);
          file.capacity = {
            source: capacity.source,
            updatedAt: capacity.updatedAt,
            ...values,
            ...(isOfflineExportFormat(capacity.offlineExportFormat) ? { offlineExportFormat } : {}),
          };
        } else if (capacity !== undefined) {
          log(`[device-capacity] ${filePath} capacity entry malformed (${JSON.stringify(capacity)}) — copying again from the synced config`);
        }
        if (migrated) {
          // Rewrite once so the file never carries the old name again. The answer, the
          // recommendation and the stored hardware carry over; nothing is re-detected.
          try {
            writeBody(file);
          } catch (err) {
            log(`[transcode-default] could not rewrite ${filePath} under the new name (${err instanceof Error ? err.message : String(err)}) — will retry on the next write`);
          }
        }
        return file;
      }
      log(`[transcode-default] ${filePath} unreadable (unknown shape) — treating this computer as fresh`);
    } catch (err) {
      log(
        `[transcode-default] ${filePath} unreadable (${err instanceof Error ? err.message : String(err)}) — treating this computer as fresh`,
      );
    }
    return null;
  };

  const writeBody = (body: DeviceSettingsFile) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, filePath);
  };

  const writeFile = (patch: Partial<Omit<DeviceSettingsFile, "version">>) => {
    writeBody({ ...(readFile() ?? { version: 1 }), ...patch });
  };

  const persist = (next: DeviceTranscodeSettings) => {
    writeFile({ transcode: next });
    current = next;
    return next;
  };

  const persistUploads = (next: DeviceUploadsDuringPlaybackSettings) => {
    writeFile({ uploadsDuringPlayback: next });
    // The first derivation is not a change: the consumer reads the initial value with getUploadsDuringPlayback().
    const changed = currentUploads !== null && currentUploads.mode !== next.mode;
    currentUploads = next;
    if (changed) for (const listener of uploadsListeners) listener(next);
    return next;
  };

  const firstStart = async (): Promise<DeviceTranscodeSettings> => {
    const now = new Date().toISOString();
    if (opts.forcedDefault) {
      const fallbackCopy = opts.forcedDefault === "on";
      log(`[transcode-default] detection skipped -> fallbackCopy=${onOff(fallbackCopy)} (first start, forced by SF_TRANSCODE_FALLBACK_COPY)`);
      return persist({
        fallbackCopy,
        answered: true,
        answer: "forced",
        recommendation: { fallbackCopy, reason: null, hardware: null, detectedAt: now },
        updatedAt: now,
      });
    }
    const hardware = await opts.probeHardware();
    const recommended = decideFallbackCopy(hardware);
    log(formatTranscodeDefaultLog(hardware, recommended, "first start"));
    log(
      `[transcode-default] recommendation fallbackCopy=${onOff(recommended)} reason=${fallbackCopyReason(hardware)} cpu="${
        hardware.cpuModel ?? "unknown"
      }" — applies until the first-run question is answered`,
    );
    // A Settings change that landed while the probe ran wins.
    if (current) return current;
    return persist({
      fallbackCopy: recommended,
      answered: false,
      answer: null,
      recommendation: { fallbackCopy: recommended, reason: fallbackCopyReason(hardware), hardware, detectedAt: now },
      updatedAt: now,
    });
  };

  const getTranscode = (): Promise<DeviceTranscodeSettings> => {
    if (current) return Promise.resolve(current);
    if (loading) return loading;
    const stored = readFile()?.transcode;
    if (stored) {
      current = stored;
      log(
        `[transcode-default] stored value fallbackCopy=${onOff(stored.fallbackCopy)} answered=${stored.answered} answer=${
          stored.answer ?? "none"
        } — detection skipped`,
      );
      return Promise.resolve(stored);
    }
    loading = firstStart().finally(() => {
      loading = null;
    });
    return loading;
  };

  const answerFirstRun = async (answer: FirstRunAnswer) => {
    const base = await getTranscode();
    if (base.answered) {
      log(`[transcode-default] first-run answer=${answer} ignored: already answered (${base.answer ?? "none"})`);
      return base;
    }
    const fallbackCopy = fallbackCopyForAnswer(base.recommendation.fallbackCopy, answer);
    log(
      `[transcode-default] first-run answer=${answer} -> fallbackCopy=${onOff(fallbackCopy)} (recommended ${onOff(
        base.recommendation.fallbackCopy,
      )})`,
    );
    return persist({ ...base, fallbackCopy, answered: true, answer, updatedAt: new Date().toISOString() });
  };

  const setFallbackCopy = async (value: boolean) => {
    // Wait for an in-flight first-start detection so its write cannot land after ours.
    const base = await getTranscode();
    log(`[transcode-default] settings change fallbackCopy=${onOff(base.fallbackCopy)} -> ${onOff(value)}`);
    return persist({ ...base, fallbackCopy: value, answered: true, answer: "settings", updatedAt: new Date().toISOString() });
  };

  const firstStartUploads = async (): Promise<DeviceUploadsDuringPlaybackSettings> => {
    const now = new Date().toISOString();
    if (opts.forcedUploadsDuringPlayback) {
      const mode = opts.forcedUploadsDuringPlayback;
      log(`[uploads-playback-default] detection skipped -> uploadsDuringPlayback=${mode} (first start, forced by SF_UPLOADS_DURING_PLAYBACK)`);
      return persistUploads({
        mode,
        answered: true,
        answer: "forced",
        recommendation: { mode, reason: null, hardware: null, detectedAt: now },
        updatedAt: now,
      });
    }
    // One detection per computer: reuse the hardware the fallback-copy question stored (or is
    // detecting right now); only a computer whose fallback-copy answer was forced has none.
    const transcode = await getTranscode();
    const hardware = transcode.recommendation.hardware ?? (await opts.probeHardware());
    const mode = decideUploadsDuringPlayback(hardware);
    const reason = uploadsDuringPlaybackReason(hardware);
    log(formatUploadsDefaultLog(hardware, mode, "first start"));
    log(
      `[uploads-playback-default] recommendation uploadsDuringPlayback=${mode} reason=${reason} cpu="${
        hardware.cpuModel ?? "unknown"
      }" — applies until the first-run question is answered`,
    );
    // A Settings change that landed while detection ran wins.
    if (currentUploads) return currentUploads;
    return persistUploads({
      mode,
      answered: false,
      answer: null,
      recommendation: { mode, reason, hardware, detectedAt: now },
      updatedAt: now,
    });
  };

  const getUploadsDuringPlayback = (): Promise<DeviceUploadsDuringPlaybackSettings> => {
    if (currentUploads) return Promise.resolve(currentUploads);
    if (loadingUploads) return loadingUploads;
    const stored = readFile()?.uploadsDuringPlayback;
    if (stored) {
      currentUploads = stored;
      log(
        `[uploads-playback-default] stored value uploadsDuringPlayback=${stored.mode} answered=${stored.answered} answer=${
          stored.answer ?? "none"
        } — detection skipped`,
      );
      return Promise.resolve(stored);
    }
    loadingUploads = firstStartUploads().finally(() => {
      loadingUploads = null;
    });
    return loadingUploads;
  };

  const uploadsDuringPlaybackNeedsDetection = (): boolean =>
    !currentUploads && !loadingUploads && !opts.forcedUploadsDuringPlayback && !readFile()?.uploadsDuringPlayback;

  const answerUploadsFirstRun = async (answer: UploadsFirstRunAnswer) => {
    const base = await getUploadsDuringPlayback();
    if (answer.kind === "chosen" && !isUploadsDuringPlayback(answer.mode)) {
      throw new Error(`invalid uploadsDuringPlayback value: ${String(answer.mode)}`);
    }
    if (base.answered) {
      log(`[uploads-playback-default] first-run answer=${answer.kind} ignored: already answered (${base.answer ?? "none"})`);
      return base;
    }
    const mode = uploadsDuringPlaybackForAnswer(base.recommendation.mode, answer);
    log(
      `[uploads-playback-default] first-run answer=${answer.kind} -> uploadsDuringPlayback=${mode} (recommended ${base.recommendation.mode})`,
    );
    return persistUploads({ ...base, mode, answered: true, answer: answer.kind, updatedAt: new Date().toISOString() });
  };

  const setUploadsDuringPlayback = async (value: UploadsDuringPlayback) => {
    if (!isUploadsDuringPlayback(value)) throw new Error(`invalid uploadsDuringPlayback value: ${String(value)}`);
    // Wait for an in-flight first-start derivation so its write cannot land after ours.
    const base = await getUploadsDuringPlayback();
    log(`[uploads-playback-default] settings change uploadsDuringPlayback=${base.mode} -> ${value}`);
    return persistUploads({ ...base, mode: value, answered: true, answer: "settings", updatedAt: new Date().toISOString() });
  };

  const onUploadsDuringPlaybackChange = (listener: (settings: DeviceUploadsDuringPlaybackSettings) => void) => {
    uploadsListeners.add(listener);
    return () => {
      uploadsListeners.delete(listener);
    };
  };

  const getCapacity = (): StoredDeviceCapacity | null => readFile()?.capacity ?? null;

  const persistCapacity = (values: DeviceCapacityValues, source: DeviceCapacitySettings["source"], updatedAt?: string) => {
    const next: DeviceCapacitySettings = { ...coerceDeviceCapacity(values), source, updatedAt: updatedAt ?? new Date().toISOString() };
    writeFile({ capacity: next });
    return next;
  };

  const adoptCapacity = (seed: DeviceCapacityValues): DeviceCapacitySettings => {
    const stored = getCapacity();
    if (stored?.offlineExportFormat) return { ...stored, offlineExportFormat: stored.offlineExportFormat };
    if (stored) {
      // OFFL-FILE-01: the format the account held moves here once; the other values and where they came from stay.
      const next = persistCapacity({ ...stored, offlineExportFormat: seed.offlineExportFormat }, stored.source, stored.updatedAt);
      log(`[device-capacity] download format copied from the synced config offlineExportFormat=${next.offlineExportFormat}`);
      return next;
    }
    const next = persistCapacity(seed, "synced-config");
    log(
      `[device-capacity] copied from the synced config maxParallelTranscodes=${next.maxParallelTranscodes} maxParallelExtractions=${next.maxParallelExtractions} watchedDirectories=${next.watchedDirectories.length} offlineExportFormat=${next.offlineExportFormat} — this computer's own values from now on`,
    );
    return next;
  };

  const setCapacity = (values: DeviceCapacityValues): DeviceCapacitySettings => {
    const next = persistCapacity(values, "settings");
    log(
      `[device-capacity] settings change maxParallelTranscodes=${next.maxParallelTranscodes} maxParallelExtractions=${next.maxParallelExtractions} watchedDirectories=${next.watchedDirectories.length} offlineExportFormat=${next.offlineExportFormat}`,
    );
    return next;
  };

  return {
    getTranscode,
    answerFirstRun,
    setFallbackCopy,
    getUploadsDuringPlayback,
    uploadsDuringPlaybackNeedsDetection,
    answerUploadsFirstRun,
    setUploadsDuringPlayback,
    onUploadsDuringPlaybackChange,
    getCapacity,
    adoptCapacity,
    setCapacity,
  };
};
