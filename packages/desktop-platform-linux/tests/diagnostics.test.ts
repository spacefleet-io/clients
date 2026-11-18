import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxDiagnostics, linuxDiagnostics } from "../src/diagnostics";

const SUITE = "linux-diagnostics";

describe.runIf(process.platform === "linux")("process diagnostics", () => {
  it("reports the kernel view of a live process", async () => {
    const read = createLinuxDiagnostics().readProcess;
    await read(process.pid);
    // cpuPctSincePrev needs the clock to move between two dumps; burn ~3 ms.
    const t0 = Date.now();
    while (Date.now() - t0 < 3) Math.sqrt(t0);
    const d = await read(process.pid);
    console.info(`[${SUITE}:diag] ${JSON.stringify(d)}`);
    expect(d.platform).toBe("linux");
    expect(d.alive).toBe(true);
    expect(typeof d.state).toBe("string");
    expect(d.threadStates).toBeTypeOf("object");
    expect(d.cpuPctSincePrev).toBeTypeOf("number");
  });

  it("says a missing pid is not alive", async () => {
    const d = await linuxDiagnostics.readProcess(2 ** 30);
    console.info(`[${SUITE}:diag-dead] ${JSON.stringify(d)}`);
    expect(d.platform).toBe("linux");
    expect(d.alive).toBe(false);
  });
});

describe("procfs fixture (procRoot seam)", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("parses stat, syscall target, threads and pressure from a fixture tree", async () => {
    root = mkdtempSync(join(tmpdir(), "sf-procfs-"));
    const pid = 4242;
    const dir = join(root, String(pid));
    mkdirSync(join(dir, "fd"), { recursive: true });
    mkdirSync(join(dir, "task", "4242"), { recursive: true });
    mkdirSync(join(dir, "task", "4243"), { recursive: true });
    mkdirSync(join(root, "pressure"), { recursive: true });
    // state D, utime=300, stime=100 -> 4 CPU seconds at 100 Hz
    const statTail = ["D", ...Array.from({ length: 10 }, () => "0"), "300", "100"].join(" ");
    writeFileSync(join(dir, "stat"), `${pid} (we ird) ${statTail}\n`);
    writeFileSync(join(dir, "wchan"), "jbd2_log_wait\n");
    symlinkSync("/data/runtime_jobs.db-wal", join(dir, "fd", "9"));
    writeFileSync(join(dir, "syscall"), "74 0x9 0x0\n");
    writeFileSync(join(dir, "status"), "Name:\tx\nVmRSS:\t   20480 kB\n");
    writeFileSync(join(dir, "task", "4242", "stat"), `4242 (a) ${statTail}\n`);
    writeFileSync(join(dir, "task", "4242", "comm"), "main\n");
    writeFileSync(join(dir, "task", "4242", "wchan"), "jbd2_log_wait\n");
    writeFileSync(join(dir, "task", "4243", "stat"), `4243 (b) S ${Array.from({ length: 12 }, () => "0").join(" ")}\n`);
    writeFileSync(join(root, "pressure", "cpu"), "some avg10=1.00 avg60=0.00 avg300=0.00 total=1\nfull x\n");

    const d = await createLinuxDiagnostics(root).readProcess(pid);
    console.info(`[${SUITE}:fixture] ${JSON.stringify(d)}`);
    expect(d).toMatchObject({
      platform: "linux",
      pid,
      alive: true,
      state: "D",
      wchan: "jbd2_log_wait",
      syscall: "fsync /data/runtime_jobs.db-wal",
      cpuSecondsTotal: 4,
      rssMb: 20,
      threadStates: { D: 1, S: 1 },
      nonSleepingThreads: ["4242:main:D:jbd2_log_wait"],
      psiCpu: "some avg10=1.00 avg60=0.00 avg300=0.00 total=1",
      psiIo: null,
    });
  });
});

describe.runIf(process.platform === "linux")("port holders", () => {
  it("finds this process as the holder of a listening port", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const d = await linuxDiagnostics.readPortHolders(port);
      console.info(`[${SUITE}:port] ${JSON.stringify(d)}`);
      expect(d.platform).toBe("linux");
      expect(d.port).toBe(port);
      expect(d.listening).toBe(true);
      expect((d.holders as Array<{ pid: number }>).some((holder) => holder.pid === process.pid)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("reports a free port as not listening", async () => {
    const d = await linuxDiagnostics.readPortHolders(1);
    console.info(`[${SUITE}:port-free] ${JSON.stringify(d)}`);
    expect(d).toMatchObject({ platform: "linux", listening: false, holders: [] });
  });
});
