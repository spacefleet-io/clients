import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWindowsGracefulStop, stopPipeName } from "../src/gracefulStop";
import type { OpenStopPipeResult } from "../src/stopPipe";
import { platform } from "../src";
import type { BunFfiModule } from "../src/win32api";

describe("windows graceful stop (pure)", () => {
  it("names the stop pipe after the pid in the \\\\.\\pipe\\ namespace", () => {
    console.info("[windows-graceful-stop] pipe for 1234 = %s", stopPipeName(1234));
    expect(stopPipeName(1234)).toBe("\\\\.\\pipe\\sf-stop-1234");
    expect(stopPipeName(1)).not.toBe(stopPipeName(2));
  });

  it("is exposed on the processes layer", () => {
    expect(platform.processes.gracefulStop.install).toBeTypeOf("function");
    expect(platform.processes.gracefulStop.request).toBeTypeOf("function");
  });
});

describe("windows graceful stop (hardened pipe, fakes)", () => {
  const ffi = {} as BunFfiModule;
  let markerDir: string;
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), "sf-stop-markers-"));
  });
  afterEach(() => {
    rmSync(markerDir, { recursive: true, force: true });
  });

  const makeStop = (options: { open?: OpenStopPipeResult; openThrows?: Error; connect?: boolean; alive?: (pid: number) => boolean; ffi?: BunFfiModule | null } = {}) => {
    const closes: string[] = [];
    const opens: Array<{ name: string; onConnection: () => void }> = [];
    const connects: string[] = [];
    const warnings: string[] = [];
    const stop = createWindowsGracefulStop({
      loadFfi: () => (options.ffi === undefined ? ffi : options.ffi),
      openPipe: (_ffi, name, onConnection) => {
        opens.push({ name, onConnection });
        if (options.openThrows) throw options.openThrows;
        return options.open ?? { ok: true, close: () => closes.push(name) };
      },
      connectPipe: (name) => {
        connects.push(name);
        return options.connect ?? true;
      },
      markerDir: () => markerDir,
      isAlive: options.alive ?? (() => true),
      warn: (message) => warnings.push(message),
    });
    return { stop, closes, opens, connects, warnings };
  };
  const markers = () => readdirSync(markerDir).sort();

  it("listens on this process's pipe, records a marker once the pipe exists, and forwards connections as 'pipe'", () => {
    const { stop, opens } = makeStop();
    const onRequest = vi.fn();
    const uninstall = stop.install(onRequest);
    console.info("[windows-graceful-stop:install] pipe=%s markers=%j", opens[0]?.name, markers());
    expect(opens.map((open) => open.name)).toEqual([stopPipeName(process.pid)]);
    expect(markers()).toEqual([String(process.pid)]);
    opens[0]!.onConnection();
    expect(onRequest).toHaveBeenCalledWith("pipe");
    process.emit("SIGINT");
    expect(onRequest).toHaveBeenCalledWith("SIGINT");
    uninstall();
  });

  it("uninstall closes the pipe, removes the marker and the SIGINT handler", () => {
    const { stop, closes } = makeStop();
    const onRequest = vi.fn();
    const before = process.listenerCount("SIGINT");
    const uninstall = stop.install(onRequest);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    uninstall();
    expect(closes).toEqual([stopPipeName(process.pid)]);
    expect(markers()).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("request() delivers only when the pipe's owner left a marker and the pipe opens", () => {
    const { stop, connects } = makeStop();
    const uninstall = stop.install(() => {});
    expect(stop.request(process.pid)).toBe(true);
    expect(connects).toEqual([stopPipeName(process.pid)]);
    uninstall();
    expect(stop.request(process.pid)).toBe(false);
    expect(connects).toHaveLength(1);
  });

  it("request() is false for a pipe nobody here owns (squatter), without opening it", () => {
    const { stop, connects } = makeStop({ connect: true });
    // The pipe is reachable (a squatter holds the name) but this pid never installed a stoppable pipe.
    expect(stop.request(4242)).toBe(false);
    expect(connects).toEqual([]);
  });

  it("request() refuses a dead pid's leftover marker without opening the pipe, and removes it", () => {
    const { stop, connects } = makeStop({ alive: () => false });
    writeFileSync(join(markerDir, "4242"), "");
    expect(stop.request(4242)).toBe(false);
    expect(connects).toEqual([]);
    expect(existsSync(join(markerDir, "4242"))).toBe(false);
  });

  it("process exit removes the marker even though the runtime never calls uninstall", () => {
    const before = process.listeners("exit");
    const { stop } = makeStop();
    const uninstall = stop.install(() => {});
    const added = process.listeners("exit").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    expect(markers()).toEqual([String(process.pid)]);
    added[0]!(0);
    expect(markers()).toEqual([]);
    uninstall();
    expect(process.listeners("exit")).toEqual(before);
  });

  it("an API failure while installing (dlopen, LocalAlloc) is reported through onUnavailable, never thrown", () => {
    const { stop } = makeStop({ openThrows: new Error("dlopen kernel32.dll failed") });
    const onUnavailable = vi.fn();
    expect(() => stop.install(() => {}, onUnavailable)()).not.toThrow();
    expect(onUnavailable.mock.calls[0]![0]).toContain("dlopen kernel32.dll failed");
    expect(markers()).toEqual([]);
  });

  it("request() is false when the marker is stale and the pipe is gone", () => {
    const { stop } = makeStop({ connect: false });
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "4242"), "");
    expect(stop.request(4242)).toBe(false);
  });

  it("a pipe that cannot be created is reported through onUnavailable, leaves no marker, and request() is false", () => {
    const { stop, warnings } = makeStop({ open: { ok: false, reason: "CreateNamedPipeW failed (name taken by another process: first instance refused)" } });
    const onUnavailable = vi.fn();
    const uninstall = stop.install(() => {}, onUnavailable);
    console.info("[windows-graceful-stop:squat] warnings=%j markers=%j", warnings, markers());
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]![0]).toContain(stopPipeName(process.pid));
    expect(onUnavailable.mock.calls[0]![0]).toContain("first instance refused");
    expect(warnings).toEqual([]);
    expect(markers()).toEqual([]);
    expect(stop.request(process.pid)).toBe(false);
    uninstall();
  });

  it("without an onUnavailable callback the failure is a warning", () => {
    const { stop, warnings } = makeStop({ open: { ok: false, reason: "first instance refused" } });
    stop.install(() => {})();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("first instance refused");
  });

  it("without bun:ffi the process is reported not gracefully stoppable (no pipe, no marker)", () => {
    const { stop, opens } = makeStop({ ffi: null });
    const onUnavailable = vi.fn();
    const uninstall = stop.install(() => {}, onUnavailable);
    expect(opens).toEqual([]);
    expect(onUnavailable.mock.calls[0]![0]).toMatch(/bun:ffi/);
    expect(markers()).toEqual([]);
    uninstall();
  });

  it("install prunes markers of dead processes and keeps live ones", () => {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "111"), "");
    writeFileSync(join(markerDir, "222"), "");
    writeFileSync(join(markerDir, "not-a-pid"), "");
    const { stop } = makeStop({ alive: (pid) => pid === 222 });
    const uninstall = stop.install(() => {});
    console.info("[windows-graceful-stop:prune] markers=%j", markers());
    expect(markers()).toEqual(["222", "not-a-pid", String(process.pid)].sort());
    expect(existsSync(join(markerDir, "111"))).toBe(false);
    uninstall();
  });
});
