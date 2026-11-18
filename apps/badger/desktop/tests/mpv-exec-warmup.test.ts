import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMpvExecWarmup, planMpvExecWarmup } from "../src/main/mpvExecWarmup";

/**
 * #928 play start: Defender scans a new mpv.exe on its first exec, and spawn
 * (a synchronous CreateProcess) blocked the Electron main thread for the
 * whole scan (~3 s on a 2-core Windows test machine). The first exec now runs once per session
 * in a worker, and the launch awaits it before spawning.
 */

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const bundle = { bin: "C:\\sf\\deps\\bin\\mpv.exe", kind: "bundle" as const, libDirs: ["C:\\sf\\deps\\bin"] };

describe("mpv exec warm-up", () => {
  it("plans `mpv --version` for a real binary and nothing for the fallback sentinel", () => {
    expect(planMpvExecWarmup(bundle)).toMatchObject({ bin: bundle.bin, args: ["--version"] });
    expect(planMpvExecWarmup({ bin: "mpv", kind: "fallback", libDirs: [] })).toBeNull();
  });

  it("shares one run between concurrent callers and does not run again once settled", async () => {
    const { promise, resolve } = Promise.withResolvers<{ ms: number; ok: boolean; error: string | null }>();
    const run = vi.fn(() => promise);
    const warmup = createMpvExecWarmup(run);
    const first = warmup.warm(bundle);
    const second = warmup.warm(bundle);
    expect(run).toHaveBeenCalledTimes(1);
    resolve({ ms: 3200, ok: true, error: null });
    await expect(first).resolves.toEqual({ ms: 3200, ok: true, error: null });
    await expect(second).resolves.toEqual({ ms: 3200, ok: true, error: null });
    await warmup.warm(bundle);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs once per binary", async () => {
    const run = vi.fn(async () => ({ ms: 30, ok: true, error: null }));
    const warmup = createMpvExecWarmup(run);
    await warmup.warm(bundle);
    await warmup.warm({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed run", async () => {
    const run = vi.fn(async () => ({ ms: 5, ok: false, error: "spawn ENOENT" }));
    const warmup = createMpvExecWarmup(run);
    await expect(warmup.warm(bundle)).resolves.toMatchObject({ ok: false });
    await warmup.warm(bundle);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips the fallback sentinel without running anything", async () => {
    const run = vi.fn(async () => ({ ms: 0, ok: true, error: null }));
    await expect(createMpvExecWarmup(run).warm({ bin: "mpv", kind: "fallback", libDirs: [] })).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a real exec in a worker thread", async () => {
    const result = await createMpvExecWarmup().warm({ bin: process.execPath, kind: "system", libDirs: [] });
    expect(result).toMatchObject({ ok: true, error: null });
  });

  it("the play handler waits for the warm-up before spawning mpv", () => {
    const source = readFileSync(path.join(__dirname, "../src/main/externalMpv.ts"), "utf8");
    const warmed = source.indexOf("await execWarmupDone");
    expect(warmed).toBeGreaterThan(0);
    expect(source.indexOf("await client.start(", warmed)).toBeGreaterThan(warmed);
    expect(source.lastIndexOf("await client.start(", warmed)).toBe(-1);
  });
});
