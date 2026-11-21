import { existsSync, promises as fs, readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";

export type SegmentEntry = {
  path: string;
  key?: string;
  uploaded?: boolean;
  sizeBytes?: number;
  checksum?: string;
  startSeconds?: number | null;
};

export type OutputState = {
  id: string;
  kind: "video" | "audio";
  quality?: string;
  codec?: string | null;
  codecString?: string | null;
  segmentSeconds: number;
  outputDir: string;
  init: SegmentEntry | null;
  segments: SegmentEntry[];
  durationSeconds?: number | null;
  totalSize?: number;
  language?: string;
  label?: string;
  chapters?: Array<{ title: string; startSeconds: number }>;
  encodingComplete?: boolean;
  completedParts?: Array<{
    partNumber: number;
    etag: string;
    sizeBytes: number;
    checksum?: string;
    path?: string;
  }>;
  uploadSessionId?: string;
  /**
   * Base64 16-byte seed this output's chunk keys derive from (LIB-FMT-11 key mode 2; key i =
   * `seedChunkKey(seed, placementId, i)` of `@space/library-db-definition/chunkLists`). Set once, before the first
   * chunk of the output is uploaded, and only on an account whose library is converted to change types 4; kept
   * across resumes so a re-upload lands on the same key. Absent: every chunk got a random key.
   */
  chunkKeySeed?: string;
};

export type SubtitleState = {
  id: string;
  path: string;
  key?: string;
  uploaded?: boolean;
  checksum?: string;
  sizeBytes?: number;
  language: string;
  label: string;
  format: string | null;
  isDefault?: boolean;
};

export type JobState<TSkipAnalysis = unknown> = {
  version: number;
  inputPath: string;
  userId: string;
  createdAt: string;
  outputs: OutputState[];
  subtitles: SubtitleState[];
  skipAnalysis?: TSkipAnalysis | null;
};

const ensureDir = async (path: string) => {
  await fs.mkdir(path, { recursive: true });
};

/**
 * Missing file → null (a new job). An unreadable file is NOT "no state": the
 * caller would restart the job from an empty state and drop every uploaded
 * flag, so it fails loud instead.
 */
const readJson = async <T>(path: string): Promise<T | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: "content.job_state.corrupt", path, bytes: raw.length, reason })
    );
    throw new Error(`JOB_STATE_CORRUPT:${path} — ${reason}`);
  }
};

let tmpCounter = 0;

/**
 * Compact JSON, not pretty-printed: a 2 h film's state holds thousands of
 * segment entries and the pretty form roughly doubled every rewrite (#671 R7).
 *
 * Write to a sibling temp file, then rename over the target: a concurrent
 * reader (another store, a requeued run) sees either the previous complete
 * file or the new one, never a truncated or interleaved one.
 */
const writeJsonAtomic = async (path: string, value: unknown) => {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(value), "utf8");
    await fs.rename(tmpPath, path);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
};

export type CompletedPart = NonNullable<OutputState["completedParts"]>[number];

/** One line of the upload ledger (`job_state.parts.jsonl`): a part that finished uploading. */
export type UploadLedgerEntry = { outputId: string; part: CompletedPart };

export const UPLOAD_LEDGER_FILE = "job_state.parts.jsonl";

/**
 * Parse an append-only ledger. A line that does not parse is skipped, not
 * fatal: a kill mid-append leaves a torn LAST line, and the cost of losing
 * that one entry is re-uploading one segment (bandwidth over data loss),
 * whereas failing here would block the whole job's resume.
 */
export const parseUploadLedger = (raw: string, path: string): UploadLedgerEntry[] => {
  const entries: UploadLedgerEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<UploadLedgerEntry>;
      if (typeof parsed?.outputId === "string" && parsed.part && typeof parsed.part.etag === "string") {
        entries.push({ outputId: parsed.outputId, part: parsed.part });
        continue;
      }
    } catch {
      // fall through to the skipped count
    }
    skipped += 1;
  }
  if (skipped > 0) {
    console.warn(
      JSON.stringify({ event: "content.job_state.ledger_lines_skipped", path, skipped, kept: entries.length })
    );
  }
  return entries;
};

const upsertCompletedPart = (output: OutputState, part: CompletedPart) => {
  if (!output.completedParts) output.completedParts = [];
  const existing = output.completedParts.findIndex((entry) => entry.partNumber === part.partNumber);
  if (existing >= 0) {
    output.completedParts[existing] = part;
  } else {
    output.completedParts.push(part);
  }
};

/**
 * Fold ledger entries into a state read from `job_state.json`: the part joins
 * `completedParts` and the init/segment whose file it is gets its uploaded
 * flag, key, size and checksum — the same fields `mediaFinalize` sets after
 * `uploadFile` returns. Idempotent, so a crash between a full save and the
 * ledger truncate (entries replayed onto a state that already holds them) is
 * harmless. Resume still head-checks every flagged object before trusting it.
 */
export const applyUploadLedger = <T extends { outputs?: OutputState[] }>(
  state: T,
  entries: UploadLedgerEntry[]
): T => {
  for (const { outputId, part } of entries) {
    const output = state.outputs?.find((entry) => entry.id === outputId);
    if (!output) continue;
    upsertCompletedPart(output, part);
    if (!part.path) continue;
    const target =
      output.init?.path === part.path
        ? output.init
        : output.segments?.find((segment) => segment.path === part.path);
    if (!target) continue;
    target.key = part.etag;
    target.uploaded = true;
    target.sizeBytes = part.sizeBytes;
    if (part.checksum) target.checksum = part.checksum;
  }
  return state;
};

/**
 * Read a `job_state.json` plus the upload ledger beside it, synchronously (for
 * the commit-recovery and cancel-cleanup readers). Missing file → null;
 * unparsable file throws, as {@link ResumableJobStateStore.open} would.
 */
export const loadJobStateSync = <T = JobState<unknown>>(statePath: string): T | null => {
  if (!existsSync(statePath)) return null;
  // Ledger first, then state: a full save that lands in between has already
  // folded those entries into the state, and replaying them is idempotent.
  // The other order could pair an old state with an already-removed ledger.
  const ledgerPath = joinPath(dirname(statePath), UPLOAD_LEDGER_FILE);
  const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : null;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as T;
  if (ledgerText !== null) {
    applyUploadLedger(state as unknown as { outputs?: OutputState[] }, parseUploadLedger(ledgerText, ledgerPath));
  }
  return state;
};

/**
 * Collect all storage object keys from a job state that have been uploaded.
 * Used to clean up orphaned chunks when a job is cancelled or removed.
 */
export const collectUploadedObjectKeys = (state: JobState<unknown>): string[] => {
  const keys: string[] = [];
  for (const output of state.outputs) {
    if (output.init?.uploaded && output.init.key) keys.push(output.init.key);
    for (const segment of output.segments) {
      if (segment.uploaded && segment.key) keys.push(segment.key);
    }
  }
  for (const subtitle of state.subtitles) {
    if (subtitle.uploaded && subtitle.key) keys.push(subtitle.key);
  }
  return keys;
};

export class ResumableJobStateStore<TSkipAnalysis = unknown> {
  readonly jobDir: string;
  readonly statePath: string;
  private current: JobState<TSkipAnalysis>;
  /** Saves run one at a time, so the last save to start is the last to land. */
  private saveChain: Promise<void> = Promise.resolve();
  readonly ledgerPath: string;

  private constructor(jobDir: string, current: JobState<TSkipAnalysis>) {
    this.jobDir = jobDir;
    this.statePath = joinPath(jobDir, "job_state.json");
    this.ledgerPath = joinPath(jobDir, UPLOAD_LEDGER_FILE);
    this.current = current;
  }

  static async open<TSkipAnalysis = unknown>(args: {
    jobDir: string;
    inputPath: string;
    userId: string;
  }): Promise<ResumableJobStateStore<TSkipAnalysis>> {
    await ensureDir(args.jobDir);
    const statePath = joinPath(args.jobDir, "job_state.json");
    const existing = await readJson<JobState<TSkipAnalysis>>(statePath);
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const current: JobState<TSkipAnalysis> = existing ?? {
      version: 1,
      inputPath: args.inputPath,
      userId: args.userId,
      createdAt,
      outputs: [],
      subtitles: [],
    };
    const store = new ResumableJobStateStore<TSkipAnalysis>(args.jobDir, current);
    const ledgerRaw = await fs.readFile(store.ledgerPath, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (ledgerRaw !== null) {
      const entries = parseUploadLedger(ledgerRaw, store.ledgerPath);
      applyUploadLedger(current, entries);
      console.info(
        JSON.stringify({ event: "content.job_state.ledger_replayed", path: store.ledgerPath, entries: entries.length })
      );
    }
    // Folds the replayed ledger into job_state.json and empties the ledger.
    await store.save();
    return store;
  }

  getState() {
    return this.current;
  }

  getOutput(outputId: string) {
    return this.current.outputs.find((entry) => entry.id === outputId) ?? null;
  }

  setSkipAnalysis(skipAnalysis: TSkipAnalysis | null | undefined) {
    this.current.skipAnalysis = skipAnalysis ?? this.current.skipAnalysis ?? null;
  }

  ensureOutput(id: string, kind: "video" | "audio", segmentSeconds: number) {
    let existingOutput = this.current.outputs.find((entry) => entry.id === id);
    if (!existingOutput) {
      existingOutput = {
        id,
        kind,
        segmentSeconds,
        outputDir: joinPath(this.jobDir, "outputs", id),
        init: null,
        segments: [],
      };
      this.current.outputs.push(existingOutput);
    }
    return existingOutput;
  }

  getCompletedParts(outputId: string) {
    return this.getOutput(outputId)?.completedParts ?? [];
  }

  async persistUploadSession(
    outputId: string,
    metadata: {
      uploadSessionId?: string;
      parts: Array<{
        partNumber: number;
        etag: string;
        sizeBytes: number;
        checksum?: string;
        path?: string;
      }>;
    }
  ) {
    const output = this.getOutput(outputId);
    if (!output) return;
    output.uploadSessionId = metadata.uploadSessionId;
    output.completedParts = [...metadata.parts];
    await this.save();
  }

  async recordCompletedPart(outputId: string, part: CompletedPart) {
    const output = this.getOutput(outputId);
    if (!output) return;
    upsertCompletedPart(output, part);
    await this.appendToLedger({ outputId, part });
  }

  /**
   * One part finished uploading: append ONE compact line instead of rewriting
   * the whole state (a 2 h film wrote ~4.2 GB of `job_state.json` this way,
   * #671 R7). Chained with {@link save} so a full save's ledger truncate
   * can never land after a later append.
   */
  private appendToLedger(entry: UploadLedgerEntry): Promise<void> {
    const run = this.saveChain.then(() => fs.appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, "utf8"));
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Full rewrite of `job_state.json`, then the upload ledger is emptied (the
   * state holds it). Saves and ledger appends overlap, so they are chained:
   * each runs in turn against the live state, and a failed one does not block
   * the next.
   */
  save(): Promise<void> {
    const run = this.saveChain.then(async () => {
      await writeJsonAtomic(this.statePath, this.current);
      // Everything in the ledger is in memory, so the state just written
      // holds it; a crash before this line only replays it again (idempotent).
      await fs.rm(this.ledgerPath, { force: true });
    });
    this.saveChain = run.catch(() => undefined);
    return run;
  }
}
