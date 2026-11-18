// The hidden encoder window's channel to the main process (PAR-FMT-02 light copies).
import type { ParrotCopyTags } from "@space/parrot-core";

export const LIGHT_COPY_IPC = {
  ready: "parrot:light-copy:ready",
  job: "parrot:light-copy:job",
  /** invoke: bytes `start..end` (inclusive) of the job's original, at most LIGHT_COPY_MAX_READ_BYTES of them. */
  read: "parrot:light-copy:read",
  done: "parrot:light-copy:done",
} as const;

/** The most the encoder window reads of an original per request: the original never crosses whole. */
export const LIGHT_COPY_MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * One original to encode: the window reads its `size` bytes through LIGHT_COPY_IPC.read. `container` and `codec` are
 * the original's (`alac` goes through ParrotAlac's decoder, the rest through Chromium's); `durationMs` decides
 * whether it decodes whole or streams.
 */
export type LightCopyJob = {
  id: number;
  size: number;
  container: string;
  codec: string;
  durationMs: number | null;
  tags: ParrotCopyTags;
  appVersion: string;
};

export type LightCopyResult = { id: number; ok: true; bytes: Uint8Array; ms: number; streamed: boolean } | { id: number; ok: false; error: string };

export type LightCopyBridge = {
  onJob: (listener: (job: LightCopyJob) => void) => void;
  read: (id: number, start: number, end: number) => Promise<Uint8Array>;
  done: (result: LightCopyResult) => void;
  ready: () => void;
};
