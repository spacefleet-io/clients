/**
 * Linux process control (the playback gate's backend): signals, taskset
 * arguments and cpu-list parsing with fake /proc and system calls. Moved with
 * the code from packages/ffmpeg/tests/playback-gate.test.ts (#25, #246); the
 * conformance suite covers the real kernel.
 */
import { describe, expect, it } from "vitest";
import { createLinuxProcessControl, countCpusOfList, lastCpuOfList } from "../src/processControl";

const TAG = "[linux-process-control]";

describe("cpu lists", () => {
  it("lastCpuOfList is the highest cpu, null when malformed", () => {
    expect(lastCpuOfList("0-3")).toBe(3);
    expect(lastCpuOfList("0-1,4,8-11")).toBe(11);
    expect(lastCpuOfList("2")).toBe(2);
    expect(lastCpuOfList("a-b")).toBeNull();
    expect(lastCpuOfList("")).toBeNull();
  });

  it("countCpusOfList counts members, null when malformed", () => {
    expect(countCpusOfList("0-3")).toBe(4);
    expect(countCpusOfList("0-1,4,8-11")).toBe(7);
    expect(countCpusOfList("2")).toBe(1);
    expect(countCpusOfList("3-1")).toBeNull();
    expect(countCpusOfList("x")).toBeNull();
  });
});

describe("linux process control @bugfix @regression-proof", () => {
  const procStat = (pid: number, startTime: string) => `${pid} (ffmpeg) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 ${startTime} 0`;

  const makeLinux = (options: { children?: Record<number, number[]>; startTimes?: Record<number, string> } = {}) => {
    const signals: string[] = [];
    const tasksets: string[][] = [];
    const childMap = options.children ?? {};
    const startTimes = options.startTimes ?? {};
    const backend = createLinuxProcessControl({
      kill: (pid, signal) => signals.push(`${signal}:${pid}`),
      readText: (path) => {
        const stat = /^\/proc\/(\d+)\/stat$/.exec(path);
        if (stat) {
          const pid = Number(stat[1]);
          return pid in startTimes ? procStat(pid, startTimes[pid]!) : null;
        }
        if (/^\/proc\/(\d+)\/status$/.test(path)) return `Name:\tffmpeg\nCpus_allowed_list:\t0-3\n`;
        if (path === "/proc/self/status") return `Name:\tbun\nCpus_allowed_list:\t0-3\n`;
        return null;
      },
      listChildren: (pid) => childMap[pid] ?? [],
      listThreadIds: (pid) => [pid, pid + 1000],
      runTaskset: (args) => {
        tasksets.push(args);
        return { status: 0, stderr: "" };
      },
    });
    return { backend, signals, tasksets };
  };

  it("is the linux backend, reconciling every second", () => {
    const { backend } = makeLinux();
    expect(backend.name).toBe("linux");
    expect(backend.reconcileMs).toBe(1000);
  });

  it("SIGSTOP / SIGCONT the process and every descendant", () => {
    const { backend, signals } = makeLinux({
      children: { 10: [11], 11: [12] },
      startTimes: { 10: "500", 11: "501", 12: "502" },
    });
    const handle = backend.open(10);
    handle.suspend();
    handle.resume();
    console.info(`${TAG} signals =`, signals);
    expect(signals).toEqual(["SIGSTOP:10", "SIGSTOP:11", "SIGSTOP:12", "SIGCONT:10", "SIGCONT:11", "SIGCONT:12"]);
  });

  it("never signals a pid that was reused by another process (start time changed)", () => {
    const startTimes: Record<number, string> = { 10: "500" };
    const { backend, signals } = makeLinux({ startTimes });
    const handle = backend.open(10);
    startTimes[10] = "99999";
    handle.suspend();
    expect(signals).toEqual([]);
  });

  it("a process that is not readable under /proc cannot be opened", () => {
    const { backend } = makeLinux();
    expect(() => backend.open(10)).toThrow(/not readable under \/proc/);
  });

  it("throttle pins every thread to the LAST allowed cpu, unthrottle gives the original set back", () => {
    const { backend, tasksets } = makeLinux({ startTimes: { 10: "500" } });
    const handle = backend.open(10);
    handle.throttle();
    handle.unthrottle();
    console.info(`${TAG} taskset =`, tasksets);
    expect(tasksets).toEqual([
      ["-a", "-p", "-c", "3", "10"],
      ["-a", "-p", "-c", "0-3", "10"],
    ]);
  });

  it("refresh only re-runs taskset when new threads appeared", () => {
    let threads = [10, 1010];
    const tasksets: string[][] = [];
    const backend = createLinuxProcessControl({
      kill: () => {},
      readText: (path) => (path.endsWith("/status") ? "Cpus_allowed_list:\t0-3\n" : procStat(10, "500")),
      listChildren: () => [],
      listThreadIds: () => threads,
      runTaskset: (args) => {
        tasksets.push(args);
        return { status: 0, stderr: "" };
      },
    });
    const handle = backend.open(10);
    handle.throttle();
    handle.refresh?.();
    expect(tasksets).toHaveLength(1);
    threads = [10, 1010, 1011];
    handle.refresh?.();
    expect(tasksets).toHaveLength(2);
  });

  it("a failing taskset surfaces as an error for the controller to log", () => {
    const backend = createLinuxProcessControl({
      kill: () => {},
      readText: (path) => (path.endsWith("/status") ? "Cpus_allowed_list:\t0-3\n" : procStat(10, "500")),
      listChildren: () => [],
      listThreadIds: (pid) => [pid],
      runTaskset: () => ({ status: 1, stderr: "taskset: failed to set pid 10's affinity: Operation not permitted" }),
    });
    const handle = backend.open(10);
    expect(() => handle.throttle()).toThrow(/Operation not permitted/);
  });

  it("allowedCpuCount reads Cpus_allowed_list of the process, null when unreadable", () => {
    const { backend } = makeLinux({ startTimes: { 10: "500" } });
    expect(backend.open(10).allowedCpuCount?.()).toBe(4);

    const noStatus = createLinuxProcessControl({
      kill: () => {},
      readText: (path) => (path.endsWith("/stat") ? procStat(10, "500") : null),
      listChildren: () => [],
      listThreadIds: (pid) => [pid],
      runTaskset: () => ({ status: 0, stderr: "" }),
    });
    expect(noStatus.open(10).allowedCpuCount?.()).toBeNull();
  });
});
