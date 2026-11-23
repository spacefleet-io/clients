import { promises as fs } from "node:fs";
import type { ResumableJobStateStore, JobState, OutputState, SegmentEntry, SubtitleState } from "@space/content-core";
import type { UploadSessionManager } from "@space/content-core/storageTransport";
import { apportionDeclaredBytes, type StorageObjectCounting } from "@space/shared/storageCounting";

export type ProducedVideoFormat = {
  quality: string;
  codec: string;
  codecString?: string | null;
  initKey: string;
  initSize: number;
  durationSeconds: number | null;
  totalSize: number;
  chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
  chapters?: Array<{ title: string; startSeconds: number }>;
};

export type ProducedAudioTrack = {
  language: string;
  label: string;
  codec: string | null;
  codecString?: string | null;
  initKey: string;
  initSize: number;
  durationSeconds: number | null;
  totalSize: number;
  chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
  isDefault?: boolean;
};

export type ProducedSubtitle = {
  language: string;
  label: string;
  objectKey: string;
  format: string | null;
  isDefault?: boolean;
};

export type ProducedMedia = {
  videoFormats: ProducedVideoFormat[];
  audioTracks: ProducedAudioTrack[];
  subtitleTracks: ProducedSubtitle[];
  /**
   * Size of the file the user added, as their computer showed it (`fs.stat`, STOR-USE-02); set when this call
   * finalized the source pieces (video source and audio) and the file could still be read; absent or null otherwise
   * (a format job, a media rebuilt from disk, the web player).
   */
  originalSizeBytes?: number | null;
};

type UploadFileResult = {
  key: string;
  sizeBytes: number;
  checksum: string;
};

type FinalizeMediaJobArgs = {
  stateStore: ResumableJobStateStore<unknown>;
  state: JobState<unknown>;
  sessionManager: UploadSessionManager;
  subtitleStates: SubtitleState[];
  audioStreamCount: number;
  includeAudio?: boolean;
  inputPath: string;
  jobDir: string;
  durationSeconds: number | null;
  chapterBoundaries: number[];
  signal?: AbortSignal;
  onUploadProgress?: (progress: number) => void;
  onLog?: (line: string) => void;
  /**
   * Per-media silo placement (#145). Every object this media produces (inits,
   * segments, subtitles) is uploaded under the same placementId.
   */
  placementId: string;
  uploadFile: (
    filePath: string,
    options?: {
      outputId?: string;
      sessionManager?: UploadSessionManager;
      signal?: AbortSignal;
      placementId?: string;
      /** How the object counts toward the allowance (STOR-USE-02). */
      counting?: StorageObjectCounting;
    }
  ) => Promise<UploadFileResult>;
  /**
   * Batched existence check for storage keys (absent from the result =
   * unknown). A resumed job's `uploaded=true` objects are verified with it
   * before the upload loop; any object not confirmed present is re-uploaded.
   */
  headObjects: (keys: string[], options?: { signal?: AbortSignal }) => Promise<Record<string, boolean>>;
};

/**
 * A resumed job trusts `uploaded=true` from its persisted state, and the
 * upload ledger (`completedParts`) hands back the key of an already-uploaded
 * file instead of uploading it again. The object behind either can be gone by
 * then: a storage GC that ran between the upload and the commit deleted it
 * (issue #25 P16, `source_missing` on play). Confirm every such object still
 * exists; flip the entries that are missing, or whose state cannot be
 * confirmed, back to pending and drop their ledger parts so the upload loop
 * really re-uploads them. Fails safe: if the check itself fails, everything is
 * re-uploaded (bandwidth over data loss).
 */
const verifyResumedUploads = async (
  state: JobState<unknown>,
  subtitleStates: SubtitleState[],
  headObjects: FinalizeMediaJobArgs["headObjects"],
  signal: AbortSignal | undefined,
  onLog: ((line: string) => void) | undefined
) => {
  const entries: Array<SegmentEntry | SubtitleState> = [];
  for (const output of state.outputs) {
    if (output.init?.uploaded) entries.push(output.init);
    for (const segment of output.segments) {
      if (segment.uploaded) entries.push(segment);
    }
  }
  for (const subtitle of subtitleStates) {
    if (subtitle.uploaded) entries.push(subtitle);
  }
  const ledgerParts = state.outputs.flatMap((output) => output.completedParts ?? []);
  if (entries.length === 0 && ledgerParts.length === 0) return;

  const keys = Array.from(
    new Set([
      ...entries.flatMap((entry) => (entry.key ? [entry.key] : [])),
      ...ledgerParts.map((part) => part.etag),
    ])
  );
  const endVerify = phaseStart(`verifyResumedUploads(${keys.length}_keys)`);
  let exists: Record<string, boolean> = {};
  let checkError: string | null = null;
  try {
    exists = keys.length > 0 ? await headObjects(keys, { signal }) : {};
  } catch (err) {
    throwIfAborted(signal);
    checkError = err instanceof Error ? err.message : String(err);
  }
  endVerify();

  const missingKeys = new Set<string>();
  let unknown = 0;
  for (const entry of entries) {
    const present = entry.key ? exists[entry.key] : undefined;
    if (present === true) continue;
    if (present === false) missingKeys.add(entry.key!);
    else unknown += 1;
    entry.uploaded = false;
  }
  let droppedLedgerParts = 0;
  for (const output of state.outputs) {
    if (!output.completedParts?.length) continue;
    const kept = output.completedParts.filter((part) => exists[part.etag] === true);
    for (const part of output.completedParts) {
      if (exists[part.etag] === false) missingKeys.add(part.etag);
    }
    droppedLedgerParts += output.completedParts.length - kept.length;
    output.completedParts = kept;
  }
  const requeued = entries.length - entries.filter((entry) => entry.uploaded).length;
  const line =
    `[upload] resume check: ${entries.length} uploaded object(s), ${entries.length - requeued} present, ` +
    `${requeued - unknown} missing, ${unknown} unconfirmed, ${droppedLedgerParts} stale upload-ledger part(s) dropped` +
    `${checkError ? ` (check failed: ${checkError})` : ""}` +
    (requeued > 0 ? `; re-uploading ${requeued}` : "");
  console.info(`[finalize] ${line}${missingKeys.size > 0 ? ` missingKeys=${JSON.stringify([...missingKeys])}` : ""}`);
  onLog?.(line);
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new Error("CANCELLED");
  }
};

/** The pieces of the file the user added: the source video and every audio track (STOR-USE-02 `source`). */
const isSourceOutput = (output: OutputState) => output.id === "video-source" || output.kind === "audio";

/**
 * STOR-USE-02: the file counts at the size the user's computer showed, spread over its source pieces in proportion to
 * each piece's size. Every source piece takes part, uploaded or not, so a resumed upload declares the same share for a
 * piece as the first try. Keyed by piece path; empty (each piece then counts its stored bytes) when the job has no
 * source pieces or the original file cannot be read any more.
 */
const sourcePieceShares = async (
  state: JobState<unknown>,
  inputPath: string,
  onLog: ((line: string) => void) | undefined
): Promise<{ originalSizeBytes: number | null; shares: Map<string, number> }> => {
  const shares = new Map<string, number>();
  const pieces: SegmentEntry[] = [];
  for (const output of state.outputs) {
    if (!isSourceOutput(output)) continue;
    if (output.init) pieces.push(output.init);
    pieces.push(...output.segments);
  }
  if (pieces.length === 0) return { originalSizeBytes: null, shares };
  const original = inputPath ? await fs.stat(inputPath).catch(() => null) : null;
  if (!original) {
    onLog?.(`[upload] original file unreadable (${inputPath || "no path"}): source pieces count their stored size`);
    return { originalSizeBytes: null, shares };
  }
  const pieceBytes = await Promise.all(
    pieces.map(async (piece) =>
      piece.uploaded && typeof piece.sizeBytes === "number"
        ? piece.sizeBytes
        : Number((await fs.stat(piece.path).catch(() => null))?.size ?? 0)
    )
  );
  const declared = apportionDeclaredBytes(original.size, pieceBytes);
  pieces.forEach((piece, index) => shares.set(piece.path, declared[index]));
  onLog?.(`[upload] original file ${original.size} B spread over ${pieces.length} source piece(s)`);
  return { originalSizeBytes: original.size, shares };
};

const buildProducedMedia = (
  state: JobState<unknown>,
  subtitleStates: SubtitleState[],
  originalSizeBytes: number | null
): ProducedMedia => {
  const videoFormats: ProducedVideoFormat[] = [];
  const audioTracks: ProducedAudioTrack[] = [];
  const subtitleTracks: ProducedSubtitle[] = [];

  for (const output of state.outputs) {
    const chunks = output.segments
      .filter((segment) => segment.key && typeof segment.sizeBytes === "number")
      .map((segment) => ({
        key: segment.key as string,
        sizeBytes: segment.sizeBytes as number,
        startSeconds: segment.startSeconds ?? null,
      }));

    const totalSize = (output.init?.sizeBytes ?? 0) + chunks.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const durationSeconds = output.durationSeconds ?? null;

    if (output.kind === "video") {
      videoFormats.push({
        quality: output.quality ?? "unknown",
        codec: output.codec ?? "h264",
        codecString: output.codecString ?? null,
        initKey: output.init?.key ?? "",
        initSize: output.init?.sizeBytes ?? 0,
        durationSeconds,
        totalSize,
        chunks,
        chapters: output.chapters,
      });
      continue;
    }

    audioTracks.push({
      language: output.language ?? "und",
      label: output.label ?? output.language?.toUpperCase() ?? "Audio",
      codec: output.codec ?? "aac",
      codecString: output.codecString ?? null,
      initKey: output.init?.key ?? "",
      initSize: output.init?.sizeBytes ?? 0,
      durationSeconds,
      totalSize,
      chunks,
      isDefault: audioTracks.length === 0,
    });
  }

  for (const subtitle of subtitleStates) {
    subtitleTracks.push({
      language: subtitle.language,
      label: subtitle.label,
      objectKey: subtitle.key ?? "",
      format: subtitle.format,
      isDefault: false,
    });
  }

  return { videoFormats, audioTracks, subtitleTracks, originalSizeBytes };
};

const collectUploadTotals = async (state: JobState<unknown>, subtitleStates: SubtitleState[]) => {
  const pendingBytesByPath = new Map<string, number>();
  let uploadedBytes = 0;
  let totalUploadBytes = 0;

  const registerPendingPath = async (filePath: string) => {
    if (pendingBytesByPath.has(filePath)) return;
    const stat = await fs.stat(filePath).catch(() => null);
    const size = Number(stat?.size ?? 0);
    pendingBytesByPath.set(filePath, size);
    totalUploadBytes += size;
  };

  for (const output of state.outputs) {
    if (output.init?.path) {
      await registerPendingPath(output.init.path);
      if (output.init.uploaded) {
        uploadedBytes += Number(output.init.sizeBytes ?? pendingBytesByPath.get(output.init.path) ?? 0);
      }
    }
    for (const segment of output.segments) {
      await registerPendingPath(segment.path);
      if (segment.uploaded) {
        uploadedBytes += Number(segment.sizeBytes ?? pendingBytesByPath.get(segment.path) ?? 0);
      }
    }
  }

  for (const subtitle of subtitleStates) {
    await registerPendingPath(subtitle.path);
    if (subtitle.uploaded) {
      uploadedBytes += Number(subtitle.sizeBytes ?? pendingBytesByPath.get(subtitle.path) ?? 0);
    }
  }

  return { uploadedBytes, totalUploadBytes };
};

/**
 * Heartbeat helper. Round-10: each major sub-phase of `finalizeMediaJob` runs
 * silently; if any of them hangs (e.g. an upload that never resolves), we lose
 * all visibility once the encode progress events stop. These start/done markers
 * land in the runtime's `runtime.log` (in its data dir) via console.info so a future
 * hang narrows down to a single sub-phase by tailing the log.
 */
const phaseStart = (label: string): (() => void) => {
  const t0 = Date.now();
  console.info(`[finalize] ${label} start`);
  return () => {
    console.info(`[finalize] ${label} done in ${Date.now() - t0}ms`);
  };
};

export const finalizeMediaJob = async (args: FinalizeMediaJobArgs): Promise<ProducedMedia> => {
  const {
    stateStore,
    state,
    sessionManager,
    subtitleStates,
    audioStreamCount,
    includeAudio,
    inputPath,
    jobDir,
    durationSeconds,
    chapterBoundaries,
    signal,
    onUploadProgress,
    onLog,
    placementId,
    uploadFile,
    headObjects,
  } = args;

  await verifyResumedUploads(state, subtitleStates, headObjects, signal, onLog);

  const source = await sourcePieceShares(state, inputPath, onLog);
  // How each piece counts toward the allowance (STOR-USE-02).
  const countingOf = (output: OutputState, piece: SegmentEntry): StorageObjectCounting =>
    isSourceOutput(output)
      ? { role: "source", ...(source.shares.has(piece.path) ? { declaredBytes: source.shares.get(piece.path) } : {}) }
      : { role: "quality_copy" };

  const endInitialSave = phaseStart("stateStore.save#pre-upload");
  await stateStore.save();
  endInitialSave();
  onUploadProgress?.(0);

  const uploadStartedAt = Date.now();
  let lastUploadTelemetryAt = 0;
  const endCollect = phaseStart("collectUploadTotals");
  const totals = await collectUploadTotals(state, subtitleStates);
  endCollect();
  let uploadedBytes = totals.uploadedBytes;
  const totalUploadBytes = totals.totalUploadBytes;

  const emitUploadTelemetry = () => {
    if (!onLog) return;
    const now = Date.now();
    if (now - lastUploadTelemetryAt < 1200) return;
    lastUploadTelemetryAt = now;
    const elapsedSec = Math.max(0.001, (now - uploadStartedAt) / 1000);
    const speedBytesPerSec = uploadedBytes / elapsedSec;
    const speedMibPerSec = speedBytesPerSec / (1024 * 1024);
    const remainingBytes = Math.max(0, totalUploadBytes - uploadedBytes);
    const etaSec = speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : null;
    const pct = totalUploadBytes > 0 ? Math.round((uploadedBytes / totalUploadBytes) * 100) : 100;
    onLog(
      `[upload] ${pct}% ${Math.round(uploadedBytes / (1024 * 1024))}/${Math.max(
        1,
        Math.round(totalUploadBytes / (1024 * 1024))
      )} MiB @ ${speedMibPerSec.toFixed(2)} MiB/s${etaSec !== null ? ` eta=${etaSec}s` : ""}`
    );
  };

  const bumpUploadProgress = () => {
    if (totalUploadBytes <= 0) {
      onUploadProgress?.(100);
      return;
    }
    const pct = Math.min(100, Math.round((uploadedBytes / totalUploadBytes) * 100));
    onUploadProgress?.(pct);
    emitUploadTelemetry();
  };

  const uploadPromises: Array<Promise<void>> = [];
  const pendingSegments = state.outputs.reduce(
    (count, output) =>
      count + (output.init && !output.init.uploaded ? 1 : 0) + output.segments.filter((s) => !s.uploaded).length,
    0
  );
  const pendingSubtitles = subtitleStates.filter((s) => !s.uploaded).length;
  onLog?.(
    `[upload] starting: ${pendingSegments} segment(s) + ${pendingSubtitles} subtitle(s), ` +
    `total=${Math.round(totalUploadBytes / (1024 * 1024))} MiB, ` +
    `already uploaded=${Math.round(uploadedBytes / (1024 * 1024))} MiB`
  );

  for (const output of state.outputs) {
    throwIfAborted(signal);
    if (!output.init) {
      throw new Error("INIT_SEGMENT_MISSING");
    }

    if (!output.init.uploaded) {
      const initOutput = output;
      uploadPromises.push((async () => {
        throwIfAborted(signal);
        const uploaded = await uploadFile(initOutput.init!.path, {
          outputId: initOutput.id,
          sessionManager,
          signal,
          placementId,
          counting: countingOf(initOutput, initOutput.init!),
        });
        initOutput.init!.key = uploaded.key;
        initOutput.init!.uploaded = true;
        initOutput.init!.sizeBytes = uploaded.sizeBytes;
        initOutput.init!.checksum = uploaded.checksum;
        uploadedBytes += uploaded.sizeBytes;
        bumpUploadProgress();
      })());
    }

    for (const segment of output.segments) {
      if (segment.uploaded) continue;
      const currentSegment = segment;
      const outputId = output.id;
      const pieceOutput = output;
      uploadPromises.push((async () => {
        throwIfAborted(signal);
        const uploaded = await uploadFile(currentSegment.path, {
          outputId,
          sessionManager,
          signal,
          placementId,
          counting: countingOf(pieceOutput, currentSegment),
        });
        currentSegment.key = uploaded.key;
        currentSegment.uploaded = true;
        currentSegment.sizeBytes = uploaded.sizeBytes;
        currentSegment.checksum = uploaded.checksum;
        uploadedBytes += uploaded.sizeBytes;
        bumpUploadProgress();
      })());
    }
  }

  for (const subtitle of subtitleStates) {
    if (subtitle.uploaded) continue;
    const currentSubtitle = subtitle;
    uploadPromises.push((async () => {
      throwIfAborted(signal);
      const uploaded = await uploadFile(currentSubtitle.path, { signal, placementId, counting: { role: "subtitle" } });
      currentSubtitle.key = uploaded.key;
      currentSubtitle.uploaded = true;
      currentSubtitle.sizeBytes = uploaded.sizeBytes;
      currentSubtitle.checksum = uploaded.checksum;
      uploadedBytes += uploaded.sizeBytes;
      bumpUploadProgress();
    })());
  }

  const endUpload = phaseStart(`upload(${uploadPromises.length}_chunks)`);
  await Promise.all(uploadPromises);
  endUpload();

  const endPostUploadSave = phaseStart("stateStore.save#post-upload");
  await stateStore.save();
  endPostUploadSave();

  const endBuild = phaseStart("buildProducedMedia");
  const produced = buildProducedMedia(state, subtitleStates, source.originalSizeBytes);
  endBuild();
  const hasPlayableAudio = produced.audioTracks.some((track) => Boolean(track.initKey && track.chunks.length > 0));
  if (includeAudio !== false && audioStreamCount > 0 && !hasPlayableAudio) {
    throw new Error("AUDIO_REQUIRED_MISSING");
  }

  return produced;
};
