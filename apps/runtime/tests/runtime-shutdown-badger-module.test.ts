/**
 * @test-id RUNTIME-SHUTDOWN-BADGER-001
 * @level unit + integration
 * @bugfix @regression-proof RT-LIFE-04 (#671 R2): the runtime's shutdown drain
 * never shut the Badger module down, so `LibraryDb.close()` (the only place a
 * pending deferred cache persist is written) never ran in production; the
 * guardian also SIGKILLed the runtime 0.5 s after the stop request.
 *
 * Unit: `BadgerModule.shutdown()` resolves only after the library DB is closed,
 * and `shutdownBadgerModule()` (the drain step) reaches the current module.
 * Integration: the REAL runtime (`bun src/index.ts`) runs the
 * `badgerModule.shutdown` step in its SIGTERM drain and exits 0 ("drained").
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { resetModulesForTests, setBadgerModuleForTests, shutdownBadgerModule } from "../src/modules";

const SUITE = "runtime-shutdown-badger-module";
const RUNTIME_DIR = join(import.meta.dirname, "..");
// Same reason as runtime-relaunch-drain: signal bun's own binary, not a version-manager shim.
const BUN =
  process.env.SF_TEST_BUN ??
  (spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim() || "bun");

const log = (label: string, message: string) => console.info(`[${SUITE}:${label}] ${message}`);

const createModule = () =>
  new BadgerModule({
    processMediaJob: vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    })),
  });

/**
 * Injects a fake open LibraryDb (no bun:sqlite under vitest) and replaces the
 * service's `close()` with one that settles only when the test releases it, so
 * a `shutdown()` that does not await the close is observable.
 */
const openFakeLibraryDb = (module: BadgerModule) => {
  const events: string[] = [];
  const release = Promise.withResolvers<void>();
  const fake = {
    close: vi.fn(() => {
      events.push("db.close");
    }),
  };
  (module.libraryDbService as unknown as { db: unknown }).db = fake;
  const realClose = module.libraryDbService.close.bind(module.libraryDbService);
  vi.spyOn(module.libraryDbService, "close").mockImplementation(async () => {
    await release.promise;
    await realClose();
  });
  return { fake, events, release };
};

describe(`[${SUITE}] Badger module shutdown closes the library DB`, () => {
  afterEach(() => {
    resetModulesForTests();
  });

  it("BadgerModule.shutdown() stays pending until the open library DB was closed @req RT-LIFE-04", async () => {
    const module = createModule();
    const { fake, events, release } = openFakeLibraryDb(module);

    let settled = false;
    const shutdown = module.shutdown().then(() => {
      settled = true;
      events.push("shutdown resolved");
    });
    // Real wall-clock turn on purpose: lets any un-awaited close path settle before asserting.
    await new Promise((r) => setTimeout(r, 25));
    log("module-shutdown", `before release: settled=${settled} events=${JSON.stringify(events)}`);
    expect(settled).toBe(false);

    release.resolve();
    await shutdown;

    log("module-shutdown", `after release: events=${JSON.stringify(events)}`);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["db.close", "shutdown resolved"]);
    expect(module.libraryDbService.getVersion()).toBe(0);
  });

  it("the drain step shutdownBadgerModule() closes the current module's library DB @req RT-LIFE-04", async () => {
    const module = createModule();
    const { fake, release } = openFakeLibraryDb(module);
    release.resolve();
    setBadgerModuleForTests(module);

    await shutdownBadgerModule();

    log("drain-step", `close calls=${fake.close.mock.calls.length}`);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("still closes the library DB when an earlier stop step throws, and surfaces the error @req RT-LIFE-04", async () => {
    const module = createModule();
    const { fake, release } = openFakeLibraryDb(module);
    release.resolve();
    (module as unknown as { stopGcTimer: () => void }).stopGcTimer = () => {
      throw new Error("gc stop boom");
    };

    await expect(module.shutdown()).rejects.toThrow("gc stop boom");

    log("stop-step-throws", `close calls=${fake.close.mock.calls.length}`);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

const freePort = () => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const address = srv.address();
    srv.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
  });
  return promise;
};

describe(`[${SUITE}] real runtime SIGTERM drain`, () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("runs the badgerModule.shutdown step and exits 0 after draining @req RT-LIFE-04", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sf-shutdown-badger-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The child is the production entrypoint, not a vitest worker.
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    delete env.NODE_ENV;
    Object.assign(env, {
      PORT: String(port),
      HOST: "127.0.0.1",
      SPACEFLEET_RUNTIME_DATA_DIR: dataDir,
      RUNTIME_MEMORY_LOG_MS: "0",
    });
    const child = spawn(BUN, ["src/index.ts"], { cwd: RUNTIME_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers<{ code: number | null; signal: string | null }>();
    child.once("exit", (code, signal) => resolveExited({ code, signal }));
    log("real-runtime", `spawned pid=${child.pid} port=${port} dataDir=${dataDir}`);

    // Real wall-clock polling on purpose: waits for a real OS process to bind a real port.
    const bootStartedAt = Date.now();
    for (;;) {
      const res = await fetch(`http://127.0.0.1:${port}/runtime/health`, { signal: AbortSignal.timeout(400) }).catch(() => null);
      if (res) break;
      if (Date.now() - bootStartedAt > 30_000) throw new Error(`[${SUITE}] runtime never answered health:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }

    child.kill("SIGTERM");
    const { code, signal } = await exited;
    const drainLines = output
      .split("\n")
      .filter((line) => /shutdown|shutting down/.test(line))
      .join("\n");
    log("real-runtime", `exit code=${code} signal=${signal}\n${drainLines}`);

    expect(drainLines).toMatch(/shutdown step done \{"step":"badgerModule\.shutdown"/);
    expect(drainLines).toMatch(/"reason":"drained"/);
    expect(code).toBe(0);
  }, 60_000);
});
