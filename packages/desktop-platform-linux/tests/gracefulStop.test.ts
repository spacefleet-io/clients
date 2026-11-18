import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxGracefulStop } from "../src/gracefulStop";

const TAG = "[linux-graceful-stop]";

const uninstallers: Array<() => void> = [];
afterEach(() => {
  for (const uninstall of uninstallers.splice(0)) uninstall();
});

describe("linux graceful stop", () => {
  it("install: SIGTERM and SIGINT call onRequest with their names, uninstall detaches them", () => {
    const termBefore = process.listenerCount("SIGTERM");
    const intBefore = process.listenerCount("SIGINT");
    const onRequest = vi.fn();
    const uninstall = linuxGracefulStop.install(onRequest);
    uninstallers.push(uninstall);
    expect(process.listenerCount("SIGTERM")).toBe(termBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(intBefore + 1);

    // Emit through the process, as the signal dispatcher does; no real signal is sent to the test runner.
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    console.info(`${TAG} onRequest calls=${JSON.stringify(onRequest.mock.calls)}`);
    expect(onRequest.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);

    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
  });

  it("request: a real SIGTERM reaches a child's handler and the child exits 0", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => process.stdout.write("got SIGTERM\\n", () => process.exit(0)));
         process.stdout.write("ready\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    uninstallers.push(() => child.kill("SIGKILL"));
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const exited = once(child, "exit");
    while (!out.includes("ready")) await once(child.stdout, "data");

    expect(linuxGracefulStop.request(child.pid!)).toBe(true);
    const [code, signal] = await exited;
    console.info(`${TAG} child exit code=${code} signal=${signal} out=${JSON.stringify(out)}`);
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(out).toContain("got SIGTERM");
  });

  it("request: false for a process that is gone", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await once(child, "exit");
    expect(linuxGracefulStop.request(child.pid!)).toBe(false);
  });
});
