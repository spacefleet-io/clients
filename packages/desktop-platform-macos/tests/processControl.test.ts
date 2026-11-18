import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDarwinProcessControl } from "../src/processControl";

const isMac = process.platform === "darwin";

describe("macOS process control", () => {
  it("SIGSTOP / SIGCONT the process and its descendants; taskpolicy -b / -B for the background-band throttle", () => {
    const signals: string[] = [];
    const policies: string[][] = [];
    // 10 -> 11 -> 12, plus an unrelated 20 and a zombie child 13 of 10.
    const table = ["10 1 10 S", "11 10 10 S", "12 11 10 R", "13 10 10 Z", "20 1 20 S"].join("\n");
    const backend = createDarwinProcessControl({
      kill: (pid, signal) => signals.push(`${signal}:${pid}`),
      runTaskpolicy: (args) => {
        policies.push(args);
        return { status: 0, stderr: "" };
      },
      runPs: (args) => (args[0] === "-axo" ? table : null),
    });
    expect(backend.throttleKind).toBe("background-band");
    expect(backend.reconcileMs).toBe(0);
    const handle = backend.open(10);
    handle.throttle();
    handle.suspend();
    handle.resume();
    handle.unthrottle();
    console.info("[process-control:darwin] signals =", signals, "taskpolicy =", policies);
    expect(signals).toEqual(["SIGSTOP:10", "SIGSTOP:11", "SIGSTOP:12", "SIGCONT:10", "SIGCONT:11", "SIGCONT:12"]);
    expect(policies).toEqual([
      ["-b", "-p", "10"],
      ["-b", "-p", "11"],
      ["-b", "-p", "12"],
      ["-B", "-p", "10"],
      ["-B", "-p", "11"],
      ["-B", "-p", "12"],
    ]);
  });

  it("throws when the root process cannot be reached, skips a descendant that exited meanwhile", () => {
    const backend = createDarwinProcessControl({
      kill: (pid) => {
        if (pid !== 10) throw new Error("ESRCH");
      },
      runTaskpolicy: (args) => (args[2] === "10" ? { status: 1, stderr: "taskpolicy: no such process" } : { status: 0, stderr: "" }),
      runPs: () => "10 1 10 S\n11 10 10 S\n",
    });
    const handle = backend.open(10);
    expect(() => handle.suspend()).not.toThrow();
    expect(() => handle.throttle()).toThrow("taskpolicy: no such process");
  });

  it("reads the background band back from the scheduling priority (4 = MAXPRI_THROTTLE)", () => {
    let pri = "31";
    const backend = createDarwinProcessControl({ runPs: (args) => (args.includes("pri=") ? `${pri}\n` : null) });
    const handle = backend.open(10);
    expect(handle.inBackgroundBand?.()).toBe(false);
    pri = "4";
    expect(handle.inBackgroundBand?.()).toBe(true);
    pri = "";
    expect(handle.inBackgroundBand?.()).toBeNull();
  });

  // @req INGS-LANE-02[runtime]
  it.skipIf(!isMac)("puts a real process and its child in the background band and takes them out again", async () => {
    // A shell with a CPU-bound child: the throttle must reach the child too (an encoder's helpers).
    const shell = spawn("/bin/sh", ["-c", "yes > /dev/null & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((resolve) => shell.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    const backend = createDarwinProcessControl();
    const root = backend.open(shell.pid!);
    const child = backend.open(childPid);
    try {
      const before = [root.inBackgroundBand?.(), child.inBackgroundBand?.()];
      root.throttle();
      const during = [root.inBackgroundBand?.(), child.inBackgroundBand?.()];
      root.unthrottle();
      const after = [root.inBackgroundBand?.(), child.inBackgroundBand?.()];
      console.info(`[process-control:darwin] background band root/child before=${before} during=${during} after=${after}`);
      expect(before).toEqual([false, false]);
      expect(during).toEqual([true, true]);
      expect(after).toEqual([false, false]);
    } finally {
      process.kill(childPid, "SIGKILL");
      shell.kill("SIGKILL");
    }
  });
});
