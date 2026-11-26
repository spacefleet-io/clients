/**
 * UX-NOTICE-06: while Badger's window is hidden its renderer may be gone (close-to-tray destroys it), so main
 * looks at the runtime's jobs itself and tells which job groups ended since the last look.
 */
import type { HiddenJobEnd, HiddenJobKind } from "@space/desktop-shell/main-shell";

export type RuntimeJobLike = {
  jobId: string;
  groupId: string;
  kind: string;
  status: string;
  payload?: Record<string, unknown> | null;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

type FilenameInputs =
  | { kind: "movie"; title: string; year?: number | null }
  | { kind: "episode"; showTitle: string; seasonNumber: number; episodeNumber: number; episodeTitle?: string | null };

const pad2 = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, "0");

/** The job's file name or title, as the Jobs panel names it (a source job's `filename` is the full path). */
const jobName = (job: RuntimeJobLike): string | null => {
  const payload = job.payload ?? {};
  if (typeof payload.filename === "string") {
    const file = payload.filename.split(/[\\/]/).pop()?.trim();
    if (file) return file;
  }
  const fi = (payload.manifest as { filenameInputs?: FilenameInputs } | undefined)?.filenameInputs;
  if (fi?.kind === "episode") return `${fi.showTitle.trim()} - S${pad2(fi.seasonNumber)}E${pad2(fi.episodeNumber)}`;
  if (fi?.kind === "movie" && fi.title.trim()) return fi.title.trim();
  return null;
};

const groupKind = (jobs: RuntimeJobLike[]): HiddenJobKind => {
  if (jobs.some((job) => job.kind === "download")) return "download";
  if (jobs.some((job) => job.kind === "export")) return "export";
  if (jobs.some((job) => job.kind === "source" || job.kind === "format")) return "import";
  return "job";
};

export type RuntimeJobLook = { ends: HiddenJobEnd[]; running: Set<string> };

/**
 * `running`: the groups that had an unfinished job at the last look. A group from that set whose jobs are now all
 * ended gives one end: failed when any job failed or was interrupted, done when all succeeded; a group the user
 * cancelled gives none. A group that left the list (dismissed) gives none either.
 */
export const lookAtRuntimeJobs = (running: ReadonlySet<string>, jobs: readonly RuntimeJobLike[]): RuntimeJobLook => {
  const groups = new Map<string, RuntimeJobLike[]>();
  for (const job of jobs) groups.set(job.groupId, [...(groups.get(job.groupId) ?? []), job]);
  const ends: HiddenJobEnd[] = [];
  const stillRunning = new Set<string>();
  for (const [groupId, group] of groups) {
    if (group.some((job) => !TERMINAL.has(job.status))) {
      stillRunning.add(groupId);
      continue;
    }
    if (!running.has(groupId)) continue;
    const failed = group.some((job) => job.status === "failed" || job.status === "interrupted");
    if (!failed && group.some((job) => job.status !== "succeeded")) continue;
    const named = group.find((job) => job.kind === "source" || job.kind === "download" || job.kind === "export") ?? group[0]!;
    ends.push({ kind: groupKind(group), outcome: failed ? "failed" : "done", name: jobName(named) });
  }
  return { ends, running: stillRunning };
};

export type HiddenRuntimeJobWatch = {
  /** Looks now (on hide), then every `intervalMs` while hidden. */
  check: () => Promise<void>;
  stop: () => void;
};

/**
 * Polls the runtime while the window is hidden. The first look after hiding only records what runs (no notice for a
 * job that ended while the window was shown: the in-app notice told about it); showing the window forgets it.
 */
export const watchHiddenRuntimeJobs = (deps: {
  isHidden: () => boolean;
  /** The runtime's jobs, or null when it cannot be asked (signed out, runtime down). */
  list: () => Promise<readonly RuntimeJobLike[] | null>;
  onEnd: (end: HiddenJobEnd) => void;
  intervalMs?: number;
}): HiddenRuntimeJobWatch => {
  let running: Set<string> | null = null;
  let busy = false;
  const check = async () => {
    if (!deps.isHidden()) {
      running = null;
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const jobs = await deps.list();
      if (!jobs || !deps.isHidden()) return;
      const look = lookAtRuntimeJobs(running ?? new Set(), jobs);
      if (running) for (const end of look.ends) deps.onEnd(end);
      running = look.running;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), deps.intervalMs ?? 10_000);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
};
