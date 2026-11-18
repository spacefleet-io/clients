import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

// AES-256-GCM decrypt on small worker_thread lanes so multi-MB media
// segments never block the Electron main event loop (issue #25,
// NEW-main-sync-decrypt). The payload's memory is transferred, not copied,
// both ways, so the main thread only pays for a message hop.
//
// Chosen over async crypto.subtle after measuring both on 8 MB objects:
// subtle.decrypt copies its input synchronously on the calling thread (~5 ms
// per 8 MB) and a seek fan-out of 8 × 8 MB still blocked the loop ~50 ms; the
// pool kept the loop under 2 ms and finished the fan-out ~2× sooner.
//
// The worker is inline source (eval) so it needs no extra bundle entry and
// works from inside app.asar.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const crypto = require("node:crypto");
const TAG_BYTES = 16;
parentPort.on("message", ({ id, key, nonce, aad, data }) => {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const head = decipher.update(data.subarray(0, data.length - TAG_BYTES));
    const tail = decipher.final();
    let out = tail.length === 0 ? head : Buffer.concat([head, tail]);
    if (out.byteOffset !== 0 || out.byteLength !== out.buffer.byteLength) {
      out = new Uint8Array(out);
    }
    parentPort.postMessage({ id, out }, [out.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

// Two lanes, so a small object (audio, low-tier video: ~0.2 MiB, most
// fetches) never queues behind a multi-MB GCM pass. With one shared pool a
// seek fan-out put small objects behind large ones on the same worker and
// their decrypt p50 went from ~0–1 ms to 5–6 ms (issue #25, P12). The small
// lane's single worker is idle most of the time; its jobs finish in well
// under a millisecond.
const BULK_LANE_SIZE = Math.max(1, Math.min(2, availableParallelism() - 1));
const SMALL_OBJECT_BYTES = 1024 * 1024;

type DecryptJob = {
  resolve: (plaintext: Buffer) => void;
  reject: (error: Error) => void;
};

type PoolWorker = {
  worker: Worker;
  jobs: Map<number, DecryptJob>;
};

type Lane = {
  workers: PoolWorker[];
  size: number;
};

type WorkerReply = { id: number; out: Uint8Array; error?: undefined } | { id: number; out?: undefined; error: string };

const bulkLane: Lane = { workers: [], size: BULK_LANE_SIZE };
const smallLane: Lane = { workers: [], size: 1 };
let nextJobId = 0;

const spawnWorker = (lane: Lane): PoolWorker => {
  const worker = new Worker(WORKER_SOURCE, { eval: true, name: "sf-media-decrypt" });
  worker.unref();
  const entry: PoolWorker = { worker, jobs: new Map() };
  worker.on("message", (reply: WorkerReply) => {
    const job = entry.jobs.get(reply.id);
    if (!job) return;
    entry.jobs.delete(reply.id);
    if (entry.jobs.size === 0) worker.unref();
    if (reply.error !== undefined) {
      job.reject(new Error(reply.error));
      return;
    }
    job.resolve(Buffer.from(reply.out.buffer, reply.out.byteOffset, reply.out.byteLength));
  });
  const fail = (error: Error) => {
    lane.workers = lane.workers.filter((candidate) => candidate !== entry);
    for (const job of entry.jobs.values()) job.reject(error);
    entry.jobs.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`media_decrypt_worker_exit_${code}`)));
  return entry;
};

const pickWorker = (lane: Lane) => {
  let best: PoolWorker | undefined;
  for (const candidate of lane.workers) {
    if (!best || candidate.jobs.size < best.jobs.size) best = candidate;
  }
  if (!best || (best.jobs.size > 0 && lane.workers.length < lane.size)) {
    best = spawnWorker(lane);
    lane.workers.push(best);
  }
  return best;
};

/**
 * Decrypts `payload.subarray(dataOffset)` (ciphertext || 16-byte GCM tag) off
 * the main thread and verifies the tag.
 *
 * Takes ownership of `payload`: when it owns its whole ArrayBuffer, that
 * buffer is transferred to the worker and `payload` is left detached (length
 * 0). Callers must not read `payload` after calling this.
 */
export const decryptAesGcmOffThread = (params: {
  key: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  payload: Buffer;
  dataOffset: number;
}): Promise<Buffer> => {
  const { payload } = params;
  const transferable =
    payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength && payload.buffer instanceof ArrayBuffer;
  const view = payload.subarray(params.dataOffset);
  const data = transferable ? view : new Uint8Array(view);
  const message = {
    id: nextJobId++,
    key: new Uint8Array(params.key),
    nonce: new Uint8Array(params.nonce),
    aad: new Uint8Array(params.aad),
    data,
  };
  const { worker, jobs } = pickWorker(data.byteLength < SMALL_OBJECT_BYTES ? smallLane : bulkLane);
  // Executor form: the tsconfig lib predates Promise.withResolvers (es2024).
  return new Promise<Buffer>((resolve, reject) => {
    jobs.set(message.id, { resolve, reject });
    worker.ref();
    try {
      worker.postMessage(message, [data.buffer as ArrayBuffer]);
    } catch (error) {
      jobs.delete(message.id);
      if (jobs.size === 0) worker.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};
