import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MpvRenderClass } from "@space/mpv-protocol";
import {
  createMpvGpuMemoryStore,
  mpvGpuIdentity,
  planMpvVo,
  prepareMpvGpuMemory,
  type MpvGpuIdentityInput,
  type MpvGpuMemoryLog,
} from "../src/main/mpvGpuMemory";

// #25 follow-up: on a machine with no usable GPU, every launch's `--vo=gpu,x11`
// probe cost ~80 MB of resident memory and 80-100 ms to the first frame before
// mpv fell back to x11 (lowend A/B, PR #313). The app remembers, per machine,
// that the GPU vo failed, keyed on the graphics stack (GPU, kernel driver,
// Mesa / driver libraries: the platform's `hardware.graphicsStack()`), the mpv
// binary and the display session, and launches straight on the CPU vo next
// time. Any identity change probes once again.

// What desktop-platform-linux's graphicsStack() returns (tests/hardware.test.ts there).
const NO_GPU_STACK = "kernel=6.8.0-45-generic ld.so.cache=1760486612672";
const BIN = { path: "/opt/SpaceBadger/resources/vendor/mpv/bin/mpv", size: 412_345, mtimeMs: 1_760_000_000_000 };
const base: MpvGpuIdentityInput = { graphicsStack: NO_GPU_STACK, mpvBinary: BIN, session: "x11=:0 wayland=" };

const recorder = () => {
  const lines: Array<{ level: "info" | "warn"; fields: object; msg: string }> = [];
  const log: MpvGpuMemoryLog = {
    info: (fields, msg) => lines.push({ level: "info", fields, msg }),
    warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
  };
  return { lines, log };
};

const CPU: MpvRenderClass = { rendering: "cpu", decoding: "software" };
const GPU: MpvRenderClass = { rendering: "gpu", decoding: "hardware" };
const UNKNOWN: MpvRenderClass = { rendering: "unknown", decoding: "unknown" };

let dirs: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-mpv-gpu-memory-"));
  dirs.push(dir);
  return join(dir, "mpv-gpu-memory.json");
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("mpvGpuIdentity", () => {
  it("is stable for the same graphics stack, mpv binary and session, and changes when any of them does @req MPV-GPU-01", () => {
    const id = mpvGpuIdentity(base);
    console.info(`[mpv-gpu-memory:identity] base=${id}`);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(mpvGpuIdentity({ ...base, mpvBinary: { ...BIN } })).toBe(id);

    const changes: Array<[string, MpvGpuIdentityInput]> = [
      ["mesa / driver libraries (ldconfig)", { ...base, graphicsStack: "kernel=6.8.0-45-generic ld.so.cache=1760999999999" }],
      ["new GPU", { ...base, graphicsStack: "kernel=6.8.0-45-generic card0=amdgpu:1002:164E ld.so.cache=1760486612672" }],
      ["kernel", { ...base, graphicsStack: "kernel=6.8.0-47-generic ld.so.cache=1760486612672" }],
      ["mpv update", { ...base, mpvBinary: { ...BIN, mtimeMs: BIN.mtimeMs + 1 } }],
      ["mpv size", { ...base, mpvBinary: { ...BIN, size: BIN.size + 1 } }],
      ["mpv path", { ...base, mpvBinary: { ...BIN, path: "/usr/bin/mpv" } }],
      ["session", { ...base, session: "x11=:97 wayland=" }],
    ];
    for (const [name, input] of changes) {
      const other = mpvGpuIdentity(input);
      console.info(`[mpv-gpu-memory:identity] ${name} -> ${other}`);
      expect(other, name).not.toBe(id);
    }
  });

  it("is null when the platform reports no graphics stack (no memory: every launch probes)", () => {
    expect(mpvGpuIdentity({ ...base, graphicsStack: null })).toBeNull();
  });
});

describe("planMpvVo", () => {
  const identity = "a".repeat(32);
  const remembered = { identity, at: "2026-10-15T00:00:00.000Z", renderPath: "cpu render, software decode (vo=x11 ...)" };

  it("launches straight on the CPU vo when this GPU identity's probe is remembered to fail @req MPV-GPU-01", () => {
    const plan = planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: { identity, remembered } });
    console.info(`[mpv-gpu-memory:plan] remembered -> ${JSON.stringify(plan)}`);
    expect(plan).toEqual({ vo: "x11", rememberOutcome: false, reason: "gpu probe skipped: remembered cpu fallback for this GPU identity" });
  });

  it("probes once again when the identity changed (driver, Mesa, GPU, mpv, session) @req MPV-GPU-01", () => {
    const plan = planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: { identity: "b".repeat(32), remembered } });
    expect(plan).toEqual({ vo: undefined, rememberOutcome: true, reason: "gpu identity changed since the remembered cpu fallback: probing the gpu vo" });
  });

  it("probes and remembers the outcome on a first launch", () => {
    expect(planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: { identity, remembered: null } })).toEqual({
      vo: undefined,
      rememberOutcome: true,
      reason: "probing the gpu vo",
    });
  });

  it("an explicit SF_MPV_EXTERNAL_VO wins and is never remembered", () => {
    for (const envVo of ["gpu-next", " x11 "]) {
      const plan = planMpvVo({ envVo, extraArgs: [], cpuVo: "x11", snapshot: { identity, remembered } });
      expect(plan).toEqual({ vo: envVo.trim(), rememberOutcome: false, reason: "SF_MPV_EXTERNAL_VO" });
    }
    // An empty value is unset.
    expect(planMpvVo({ envVo: "  ", extraArgs: [], cpuVo: "x11", snapshot: { identity, remembered } }).vo).toBe("x11");
  });

  // @bugfix gpu-probe-memory-remembers-extra-args-vo @regression-proof
  // mpv takes the last --vo, and the extra args (SF_MPV_EXTERNAL_ARGS) come after
  // the app's: a vo pinned there is just as explicit and must not be remembered
  // as this machine's GPU failure (Review335 P3).
  it("a vo pinned in the extra mpv args is never remembered and leaves the vo to them @req MPV-GPU-01", () => {
    for (const extraArgs of [["--vo=x11"], ["--fs", "--vo", "x11"]]) {
      const plan = planMpvVo({ envVo: undefined, extraArgs, cpuVo: "x11", snapshot: { identity, remembered: null } });
      console.info(`[mpv-gpu-memory:plan] extraArgs=${JSON.stringify(extraArgs)} -> ${JSON.stringify(plan)}`);
      expect(plan).toEqual({ vo: undefined, rememberOutcome: false, reason: "SF_MPV_EXTERNAL_ARGS sets the vo" });
    }
    // Options that only start with "--vo" are not the vo.
    expect(planMpvVo({ envVo: undefined, extraArgs: ["--vo-x11-something=1"], cpuVo: "x11", snapshot: { identity, remembered: null } }).rememberOutcome).toBe(true);
  });

  it("always probes, remembering nothing, when the platform has no CPU vo or the identity is unknown or not resolved yet", () => {
    expect(planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: null, snapshot: { identity, remembered } })).toEqual({
      vo: undefined,
      rememberOutcome: false,
      reason: "no separate cpu vo on this platform",
    });
    expect(planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: { identity: null, remembered } })).toEqual({
      vo: undefined,
      rememberOutcome: false,
      reason: "gpu identity unknown",
    });
    expect(planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: null })).toEqual({
      vo: undefined,
      rememberOutcome: false,
      reason: "gpu identity not resolved yet",
    });
  });
});

describe("createMpvGpuMemoryStore", () => {
  it("remembers a cpu fallback, forgets it on a gpu success, ignores an unknown path, and writes only on change @req MPV-GPU-01", async () => {
    const filePath = tempFile();
    const { lines, log } = recorder();
    const store = createMpvGpuMemoryStore({ filePath, log, now: () => Date.UTC(2026, 9, 15) });
    expect(await store.load()).toBeNull();

    await store.recordOutcome("id-1", CPU, "cpu render (vo=x11)");
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    console.info(`[mpv-gpu-memory:store] after cpu -> ${JSON.stringify(written)}`);
    expect(written).toEqual({ version: 1, identity: "id-1", at: "2026-10-15T00:00:00.000Z", renderPath: "cpu render (vo=x11)" });

    // A second store (next app start) reads it back.
    expect(await createMpvGpuMemoryStore({ filePath, log }).load()).toEqual({
      identity: "id-1",
      at: "2026-10-15T00:00:00.000Z",
      renderPath: "cpu render (vo=x11)",
    });

    // Same identity again: no rewrite.
    writeFileSync(filePath, JSON.stringify({ ...written, renderPath: "marker" }));
    await store.recordOutcome("id-1", CPU, "cpu render (vo=x11)");
    expect(JSON.parse(readFileSync(filePath, "utf8")).renderPath).toBe("marker");

    await store.recordOutcome("id-1", UNKNOWN, "unknown render");
    expect(existsSync(filePath)).toBe(true);

    await store.recordOutcome("id-2", GPU, "gpu render (vo=gpu)");
    expect(existsSync(filePath)).toBe(false);
    console.info(`[mpv-gpu-memory:store] log=${JSON.stringify(lines.map((line) => line.msg))}`);
    expect(lines.map((line) => line.msg)).toEqual([
      "gpu probe memory: remembered cpu fallback for this GPU identity",
      "gpu probe memory: gpu vo works for this GPU identity, forgot the cpu fallback",
    ]);
  });

  it("reads a corrupt or foreign file as nothing remembered (warns, never throws)", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 2, identity: "x" }), JSON.stringify({ version: 1 })]) {
      const filePath = tempFile();
      writeFileSync(filePath, content);
      const { lines, log } = recorder();
      expect(await createMpvGpuMemoryStore({ filePath, log }).load(), content).toBeNull();
      expect(lines.some((line) => line.level === "warn"), content).toBe(true);
    }
  });

  it("warns instead of throwing when the file cannot be written", async () => {
    const { lines, log } = recorder();
    // The parent "directory" is a file: mkdir/write fail with ENOTDIR.
    const blocker = tempFile();
    writeFileSync(blocker, "");
    const store = createMpvGpuMemoryStore({ filePath: join(blocker, "mpv-gpu-memory.json"), log });
    await store.recordOutcome("id-1", CPU, "cpu render");
    expect(lines.filter((line) => line.level === "warn").map((line) => line.msg)).toEqual(["gpu probe memory: write failed"]);
  });
});

describe("prepareMpvGpuMemory", () => {
  it("resolves the identity and the remembered fallback off the launch path; null until then, identity null without a graphics stack or mpv binary", async () => {
    const filePath = tempFile();
    const { log } = recorder();
    const identity = mpvGpuIdentity(base);
    await createMpvGpuMemoryStore({ filePath, log }).recordOutcome(identity ?? "", CPU, "cpu render (vo=x11)");

    const prepare = (graphicsStack: string | null, mpvBinary: typeof BIN | null) =>
      prepareMpvGpuMemory({
        store: createMpvGpuMemoryStore({ filePath, log }),
        graphicsStack: () => graphicsStack,
        mpvBinary: () => mpvBinary,
        session: base.session,
        log,
      });
    const memory = prepare(NO_GPU_STACK, BIN);
    // The stored memory is read asynchronously: a launch before that probes.
    expect(memory.snapshot()).toBeNull();
    await memory.ready;
    console.info(`[mpv-gpu-memory:prepare] ${JSON.stringify(memory.snapshot())}`);
    expect(memory.snapshot()).toEqual({ identity, remembered: { identity, at: expect.any(String), renderPath: "cpu render (vo=x11)" } });

    for (const [stack, bin] of [[null, BIN], [NO_GPU_STACK, null]] as const) {
      const other = prepare(stack, bin);
      await other.ready;
      expect(other.snapshot()?.identity, `${stack} ${bin?.path}`).toBeNull();
    }
  });

  // @bugfix gpu-probe-memory-same-session-reprobe @regression-proof
  // The snapshot was a copy taken at app start, so after the first launch
  // learned the CPU fallback every later launch of the same app session still
  // paid the GPU probe until a restart (Review335 P2).
  it("a fallback learned during this app session applies to the next launch, and a gpu success undoes it @req MPV-GPU-01", async () => {
    const { log } = recorder();
    const memory = prepareMpvGpuMemory({
      store: createMpvGpuMemoryStore({ filePath: tempFile(), log }),
      graphicsStack: () => NO_GPU_STACK,
      mpvBinary: () => BIN,
      session: base.session,
      log,
    });
    await memory.ready;
    const identity = memory.snapshot()?.identity ?? "";
    const plan = () => planMpvVo({ envVo: undefined, extraArgs: [], cpuVo: "x11", snapshot: memory.snapshot() });
    expect(plan().reason).toBe("probing the gpu vo");

    await memory.store.recordOutcome(identity, CPU, "cpu render (vo=x11)");
    console.info(`[mpv-gpu-memory:session] after cpu outcome -> ${JSON.stringify(plan())}`);
    expect(plan()).toEqual({ vo: "x11", rememberOutcome: false, reason: "gpu probe skipped: remembered cpu fallback for this GPU identity" });

    await memory.store.recordOutcome(identity, GPU, "gpu render (vo=gpu)");
    expect(plan().reason).toBe("probing the gpu vo");
  });
});
