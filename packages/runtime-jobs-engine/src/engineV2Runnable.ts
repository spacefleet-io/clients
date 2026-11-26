/**
 * In-memory runnable set for engineV2's scheduler (#671 R6, RT-JOBS-06).
 *
 * Before this, every `tick()` re-read every queued job from SQLite and, per
 * job, its parents and its steps: a queue of N jobs cost O(N) statements per
 * tick and a tick ran on every submit and every step end, so submitting N jobs
 * cost O(N^2) and blocked the event loop for 100+ ms at 600 jobs.
 *
 * The set keeps, for the jobs that are `queued`:
 *   - `buckets`: the jobs that are ready to start (parents far enough along,
 *     a runnable step), one ordered list per lane, plus one for lane-exempt
 *     steps. Order is `(priority, createdAt, first-seen)`, the order
 *     `listJobs` returns. A tick looks only at the buckets whose lane has a
 *     free slot, so a full lane costs nothing.
 *   - `parked`: jobs that must wait for a parent. They are indexed by parent id
 *     and re-examined only when that parent changes (`wake`), not on every tick.
 *   - `incoming`: ids that need (re)classification on the next tick.
 *
 * This module is pure bookkeeping: no I/O, no knowledge of SQLite or of what a
 * "ready" job is. engineV2 classifies a job, then places or parks it here.
 */

import type { IngestJobLane } from "@space/runtime-jobs";

/** One bucket per lane, plus the steps that never hold a lane (see `LANE_EXEMPT_STEP_KINDS`). */
export type RunnableBucketKey = IngestJobLane | "exempt";

export const RUNNABLE_BUCKET_KEYS: readonly RunnableBucketKey[] = [
  "source",
  "format",
  "upload",
  "exempt",
];

export interface RunnableEntry {
  jobId: string;
  priority: number;
  createdAt: string;
  /** First-seen order of the job, the tie-break when priority and createdAt are equal. */
  seq: number;
  bucket: RunnableBucketKey;
}

export interface RunnableSetStats {
  /** Jobs ready to start, per bucket. */
  ready: Record<RunnableBucketKey, number>;
  /** Jobs waiting for a parent. */
  parked: number;
  /** Jobs waiting to be classified on the next tick. */
  incoming: number;
}

type Bucket = { items: RunnableEntry[]; head: number };

const compareEntries = (a: RunnableEntry, b: RunnableEntry): number =>
  a.priority - b.priority ||
  (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
  a.seq - b.seq;

export interface RunnableSet {
  /**
   * `jobId` is queued (new, requeued after a step, or woken): classify it on
   * the next tick. Idempotent while it is already waiting for that.
   */
  enqueue(jobId: string): void;
  /** Ids to classify, in the order they were enqueued. Empties the list. */
  drainIncoming(): string[];
  /** Put a classified, ready job in its bucket. */
  place(jobId: string, priority: number, createdAt: string, bucket: RunnableBucketKey): void;
  /** The job cannot start until one of `waitsOn` changes; `wake` it then. */
  park(jobId: string, waitsOn: readonly string[]): void;
  /** `parentId` changed state: re-classify the jobs parked on it. Returns how many. */
  wake(parentId: string): number;
  /**
   * The best ready entry among the buckets `isOpen` accepts (lane has a free
   * slot), in global `(priority, createdAt, first-seen)` order, or null.
   * Does not remove it: call `consume`.
   */
  peek(isOpen: (bucket: RunnableBucketKey) => boolean): RunnableEntry | null;
  /** Remove the entry `peek` returned. */
  consume(entry: RunnableEntry): void;
  /** The job is no longer waiting to run (terminal, or gone): drop its bookkeeping. */
  forget(jobId: string): void;
  clear(): void;
  stats(): RunnableSetStats;
}

export function createRunnableSet(): RunnableSet {
  const buckets: Record<RunnableBucketKey, Bucket> = {
    source: { items: [], head: 0 },
    format: { items: [], head: 0 },
    upload: { items: [], head: 0 },
    exempt: { items: [], head: 0 },
  };
  /** Ids in `incoming` or in a bucket (not parked, not consumed). Makes `enqueue` idempotent. */
  const known = new Set<string>();
  let incoming: string[] = [];
  /** child -> the parent ids it waits on. */
  const parkedOn = new Map<string, readonly string[]>();
  /** parent -> children parked on it. */
  const waiters = new Map<string, Set<string>>();
  /** First-seen order per live job; dropped by `forget`. */
  const seqs = new Map<string, number>();
  let nextSeq = 0;

  const unpark = (jobId: string): void => {
    const parents = parkedOn.get(jobId);
    if (!parents) return;
    parkedOn.delete(jobId);
    for (const parentId of parents) {
      const set = waiters.get(parentId);
      if (!set) continue;
      set.delete(jobId);
      if (set.size === 0) waiters.delete(parentId);
    }
  };

  const seqOf = (jobId: string): number => {
    let seq = seqs.get(jobId);
    if (seq === undefined) {
      seq = nextSeq;
      nextSeq += 1;
      seqs.set(jobId, seq);
    }
    return seq;
  };

  return {
    /**
     * `jobId` is queued (new, requeued after a step, or woken): classify it on
     * the next tick. Idempotent while it is already waiting for that.
     */
    enqueue(jobId: string): void {
      if (known.has(jobId)) return;
      unpark(jobId);
      seqOf(jobId);
      known.add(jobId);
      incoming.push(jobId);
    },

    /** Ids to classify, in the order they were enqueued. Empties the list. */
    drainIncoming(): string[] {
      if (incoming.length === 0) return incoming;
      const drained = incoming;
      incoming = [];
      return drained;
    },

    /** Put a classified, ready job in its bucket. */
    place(jobId: string, priority: number, createdAt: string, bucket: RunnableBucketKey): void {
      const entry: RunnableEntry = { jobId, priority, createdAt, seq: seqOf(jobId), bucket };
      known.add(jobId);
      const b = buckets[bucket];
      let lo = b.head;
      let hi = b.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareEntries(b.items[mid]!, entry) <= 0) lo = mid + 1;
        else hi = mid;
      }
      b.items.splice(lo, 0, entry);
    },

    /** The job cannot start until one of `waitsOn` changes; `wake` it then. */
    park(jobId: string, waitsOn: readonly string[]): void {
      known.delete(jobId);
      unpark(jobId);
      if (waitsOn.length === 0) return;
      parkedOn.set(jobId, waitsOn);
      for (const parentId of waitsOn) {
        let set = waiters.get(parentId);
        if (!set) {
          set = new Set();
          waiters.set(parentId, set);
        }
        set.add(jobId);
      }
    },

    /** `parentId` changed state: re-classify the jobs parked on it. Returns how many. */
    wake(parentId: string): number {
      const set = waiters.get(parentId);
      if (!set) return 0;
      const children = [...set];
      for (const childId of children) this.enqueue(childId);
      return children.length;
    },

    /**
     * The best ready entry among the buckets `isOpen` accepts (lane has a free
     * slot), in global `(priority, createdAt, first-seen)` order, or null.
     * Does not remove it: call `consume`.
     */
    peek(isOpen: (bucket: RunnableBucketKey) => boolean): RunnableEntry | null {
      let best: RunnableEntry | null = null;
      for (const key of RUNNABLE_BUCKET_KEYS) {
        const b = buckets[key];
        if (b.head >= b.items.length || !isOpen(key)) continue;
        const head = b.items[b.head]!;
        if (best === null || compareEntries(head, best) < 0) best = head;
      }
      return best;
    },

    /** Remove the entry `peek` returned. */
    consume(entry: RunnableEntry): void {
      const b = buckets[entry.bucket];
      if (b.items[b.head] !== entry) {
        // Not the head (caller bug): fall back to a search so nothing is lost.
        const index = b.items.indexOf(entry, b.head);
        if (index < 0) return;
        b.items.splice(index, 1);
      } else {
        b.head += 1;
        if (b.head >= 64 && b.head * 2 >= b.items.length) {
          b.items.splice(0, b.head);
          b.head = 0;
        }
      }
      known.delete(entry.jobId);
    },

    /** The job is no longer waiting to run (terminal, or gone): drop its bookkeeping. */
    forget(jobId: string): void {
      known.delete(jobId);
      unpark(jobId);
      seqs.delete(jobId);
    },

    clear(): void {
      for (const key of RUNNABLE_BUCKET_KEYS) {
        buckets[key].items = [];
        buckets[key].head = 0;
      }
      known.clear();
      incoming = [];
      parkedOn.clear();
      waiters.clear();
      seqs.clear();
      nextSeq = 0;
    },

    stats(): RunnableSetStats {
      const ready = {} as Record<RunnableBucketKey, number>;
      for (const key of RUNNABLE_BUCKET_KEYS) {
        ready[key] = buckets[key].items.length - buckets[key].head;
      }
      return { ready, parked: parkedOn.size, incoming: incoming.length };
    },
  };
}
