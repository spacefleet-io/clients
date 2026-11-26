/**
 * Per-machine memory of a failed mpv GPU probe (#25).
 *
 * mpv launches with the platform's GPU-first vo list (Linux `gpu,x11`, or
 * `gpu,wlshm` in a Wayland session). On a machine with no usable GPU every
 * launch paid for the `gpu` probe before mpv fell back to the CPU vo
 * (`x11` / `wlshm`): ~80 MB more resident memory for the whole playback and
 * 80-100 ms more to the first frame (lowend A/B, PR #313). The first launch's
 * render path (mpvRenderPathLog.ts) now tells this store whether the GPU vo
 * worked. When it did not, later launches go straight to the platform's CPU vo
 * while the identity stays the same: the host's graphics stack (the platform's
 * `hardware.graphicsStack()`: on Linux the kernel, each GPU's driver and PCI
 * id, the driver module version and the ldconfig cache that moves with every
 * Mesa / GPU-library install), the mpv binary (path, size, mtime: an app update
 * re-probes) and the display session. Any change probes once again; a GPU
 * success forgets the fallback. Electron's getGPUInfo is not used: on Linux it
 * only has PCI ids (no driver, no GL strings) and fails under --disable-gpu.
 *
 * Only platforms with a separate CPU vo use it (Windows' CPU path is a WARP
 * device inside the gpu vo: nothing to skip). An explicit `SF_MPV_EXTERNAL_VO`
 * wins and is never remembered.
 *
 * Stored in `<userData>/mpv-gpu-memory.json` (one record, present only while a
 * fallback is remembered). No Electron import: the graphics stack, the binary
 * stamp and the file path are injected (tests/mpv-gpu-memory.test.ts).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MpvRenderClass } from "@space/mpv-protocol";

export type MpvBinaryStamp = { path: string; size: number; mtimeMs: number };

export type MpvGpuIdentityInput = {
  /** The platform's `hardware.graphicsStack()`; null = unknown. */
  graphicsStack: string | null;
  mpvBinary: MpvBinaryStamp;
  /** The display session mpv opens its window on (X display, Wayland socket). */
  session: string;
};

/** A remembered GPU-vo failure. */
export type MpvGpuFailure = { identity: string; at: string; renderPath: string };

export type MpvGpuMemorySnapshot = { identity: string | null; remembered: MpvGpuFailure | null };

export type MpvVoPlan = {
  /** The vo to pass to mpv; undefined = the platform's GPU-first default. */
  vo: string | undefined;
  /** Whether this launch's render path should update the memory. */
  rememberOutcome: boolean;
  reason: string;
};

export type MpvGpuMemoryLog = {
  info: (fields: object, msg: string) => void;
  warn: (fields: object, msg: string) => void;
};

/** Hash of what decides whether mpv's GPU vo can start here; null when the graphics stack is unknown. */
export const mpvGpuIdentity = (input: MpvGpuIdentityInput): string | null => {
  if (input.graphicsStack === null) return null;
  const { path, size, mtimeMs } = input.mpvBinary;
  const key = JSON.stringify({ stack: input.graphicsStack, mpv: [path, size, mtimeMs], session: input.session });
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
};

/** `--vo=…` or `--vo …`: mpv takes the last one, and the extra args come after the app's. */
const VO_ARG = /^--vo(=|$)/;

export const planMpvVo = (input: {
  envVo: string | undefined;
  /** The extra mpv args (SF_MPV_EXTERNAL_ARGS and the launch plan's). */
  extraArgs: readonly string[];
  cpuVo: string | null;
  snapshot: MpvGpuMemorySnapshot | null;
}): MpvVoPlan => {
  const envVo = input.envVo?.trim();
  if (envVo) return { vo: envVo, rememberOutcome: false, reason: "SF_MPV_EXTERNAL_VO" };
  if (input.extraArgs.some((arg) => VO_ARG.test(arg))) return { vo: undefined, rememberOutcome: false, reason: "SF_MPV_EXTERNAL_ARGS sets the vo" };
  if (input.cpuVo === null) return { vo: undefined, rememberOutcome: false, reason: "no separate cpu vo on this platform" };
  if (input.snapshot === null) return { vo: undefined, rememberOutcome: false, reason: "gpu identity not resolved yet" };
  const { identity, remembered } = input.snapshot;
  if (identity === null) return { vo: undefined, rememberOutcome: false, reason: "gpu identity unknown" };
  if (remembered?.identity === identity) {
    return { vo: input.cpuVo, rememberOutcome: false, reason: "gpu probe skipped: remembered cpu fallback for this GPU identity" };
  }
  return {
    vo: undefined,
    rememberOutcome: true,
    reason: remembered ? "gpu identity changed since the remembered cpu fallback: probing the gpu vo" : "probing the gpu vo",
  };
};

const parseFailure = (raw: unknown): MpvGpuFailure | null => {
  if (typeof raw !== "object" || raw === null || Reflect.get(raw, "version") !== 1) return null;
  const [identity, at, renderPath]: unknown[] = ["identity", "at", "renderPath"].map((field) => Reflect.get(raw, field));
  if (typeof identity !== "string" || typeof at !== "string" || typeof renderPath !== "string") return null;
  return { identity, at, renderPath };
};

export type MpvGpuMemoryStore = {
  /** Read the remembered fallback (once; later calls return the cached value). */
  load: () => Promise<MpvGpuFailure | null>;
  /** The remembered fallback as of now (null before `load` settled). */
  current: () => MpvGpuFailure | null;
  /** Learn from a GPU-first launch's render path; writes only when the memory changes. */
  recordOutcome: (identity: string, renderClass: MpvRenderClass, renderPath: string) => Promise<void>;
};

export const createMpvGpuMemoryStore = (deps: { filePath: string; log: MpvGpuMemoryLog; now?: () => number }): MpvGpuMemoryStore => {
  let cached: MpvGpuFailure | null | undefined;
  const load = async (): Promise<MpvGpuFailure | null> => {
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = await readFile(deps.filePath, "utf8");
    } catch {
      cached = null;
      return cached;
    }
    try {
      cached = parseFailure(JSON.parse(text));
    } catch {
      cached = null;
    }
    if (cached === null) deps.log.warn({ filePath: deps.filePath }, "gpu probe memory: unreadable file ignored");
    return cached;
  };
  const recordOutcome = async (identity: string, renderClass: MpvRenderClass, renderPath: string): Promise<void> => {
    const current = await load();
    try {
      if (renderClass.rendering === "cpu" && current?.identity !== identity) {
        const record: MpvGpuFailure = { identity, at: new Date(deps.now?.() ?? Date.now()).toISOString(), renderPath };
        await mkdir(dirname(deps.filePath), { recursive: true });
        const tmp = `${deps.filePath}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 1, ...record }));
        await rename(tmp, deps.filePath);
        cached = record;
        deps.log.info({ identity, renderPath }, "gpu probe memory: remembered cpu fallback for this GPU identity");
      } else if (renderClass.rendering === "gpu" && current !== null) {
        await rm(deps.filePath, { force: true });
        cached = null;
        deps.log.info({ identity, forgot: current.identity }, "gpu probe memory: gpu vo works for this GPU identity, forgot the cpu fallback");
      }
    } catch (error) {
      deps.log.warn({ filePath: deps.filePath, error: error instanceof Error ? error.message : String(error) }, "gpu probe memory: write failed");
    }
  };
  return { load, current: () => cached ?? null, recordOutcome };
};

export type MpvGpuMemory = {
  /**
   * null until the identity and the stored memory are resolved: launches before
   * that probe. Reads the store live, so a fallback learned by this session's
   * first launch applies to its next one.
   */
  snapshot: () => MpvGpuMemorySnapshot | null;
  ready: Promise<void>;
  store: MpvGpuMemoryStore;
};

/**
 * Resolve the identity and the remembered fallback at app start, off the
 * launch path (the stored memory is read asynchronously). Never throws.
 */
export const prepareMpvGpuMemory = (deps: {
  store: MpvGpuMemoryStore;
  graphicsStack: () => string | null;
  mpvBinary: () => MpvBinaryStamp | null;
  session: string;
  log: MpvGpuMemoryLog;
}): MpvGpuMemory => {
  // undefined until resolved; null = no identity.
  let identity: string | null | undefined;
  const ready = (async () => {
    const remembered = await deps.store.load();
    const graphicsStack = deps.graphicsStack();
    const mpvBinary = deps.mpvBinary();
    identity = mpvBinary === null ? null : mpvGpuIdentity({ graphicsStack, mpvBinary, session: deps.session });
    deps.log.info({ identity, graphicsStack, mpvBinary, session: deps.session, remembered }, "gpu probe memory: ready");
  })();
  return { snapshot: () => (identity === undefined ? null : { identity, remembered: deps.store.current() }), ready, store: deps.store };
};
