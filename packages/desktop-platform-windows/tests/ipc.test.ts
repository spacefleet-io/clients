import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createWindowsMpvIpc, windowsMpvIpc } from "../src/ipc";

describe("windows mpv ipc", () => {
  it("names a pipe \\\\.\\pipe\\sf-mpv-<token>", () => {
    const endpoint = windowsMpvIpc.endpoint("abc-123");
    console.info("[windows-ipc:endpoint]", endpoint);
    expect(endpoint).toBe("\\\\.\\pipe\\sf-mpv-abc-123");
    expect(windowsMpvIpc.endpoint("other")).not.toBe(endpoint);
  });

  it("reports nothing for a pipe nobody serves and remove is a repeatable no-op", () => {
    const endpoint = windowsMpvIpc.endpoint(`absent-${process.pid}`);
    expect(createWindowsMpvIpc({ listPipes: () => [] }).exists(endpoint)).toBe(false);
    expect(() => windowsMpvIpc.remove(endpoint)).not.toThrow();
    expect(() => windowsMpvIpc.remove(endpoint)).not.toThrow();
  });

  it("connect returns a socket that errors for an endpoint nobody listens on", async () => {
    const socket = windowsMpvIpc.connect(windowsMpvIpc.endpoint(`nobody-${process.pid}`));
    const outcome = await new Promise<string>((resolve) => {
      socket.on("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
      socket.on("connect", () => resolve("connected"));
    });
    socket.destroy();
    console.info("[windows-ipc:connect] outcome", outcome);
    expect(outcome).not.toBe("connected");
  });

  // @bugfix @regression-proof: existsSync on a pipe path is a CreateFile on it, which takes a free
  // instance of mpv's single-instance pipe (or hits ERROR_PIPE_BUSY while mpv re-creates it), so
  // the pre-request check made playback fail with mpv_socket_missing on ~3 of 5 launches.
  describe("exists lists the pipe directory and never opens the pipe", () => {
    const names = ["sf-mpv-abc-123", "other-pipe"];
    const listPipes = vi.fn(() => names);
    const ipc = createWindowsMpvIpc({ listPipes });

    it("is true for a listed pipe and false for an unlisted one", () => {
      expect(ipc.exists("\\\\.\\pipe\\sf-mpv-abc-123")).toBe(true);
      expect(ipc.exists("\\\\.\\pipe\\sf-mpv-missing")).toBe(false);
      expect(listPipes).toHaveBeenCalledWith();
    });

    it("compares pipe names case-insensitively, like the Windows pipe namespace", () => {
      expect(ipc.exists("\\\\.\\PIPE\\SF-MPV-ABC-123")).toBe(true);
    });

    it("is false for a path outside the pipe namespace", () => {
      expect(ipc.exists("C:\\temp\\sf-mpv-abc-123")).toBe(false);
      expect(ipc.exists("\\\\.\\pipe\\sf-mpv-abc-123\\sub")).toBe(false);
    });
  });
});

describe.skipIf(process.platform !== "win32")("windows mpv ipc exists (real pipe)", () => {
  it("checking a single-instance pipe any number of times never connects to it", async () => {
    const name = `sf-ipc-exists-${process.pid}-${Date.now()}`;
    const endpoint = `\\\\.\\pipe\\${name}`;
    const helper = spawn(
      "bun",
      [
        "-e",
        `
const { openStopPipe } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/stopPipe.ts", import.meta.url))).href)});
const { loadBunFfi } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/win32api.ts", import.meta.url))).href)});
let connections = 0;
const opened = openStopPipe(loadBunFfi(), ${JSON.stringify(endpoint)}, () => { connections += 1; console.log("connection " + connections); }, 20);
console.log(opened.ok ? "ready" : "failed " + opened.reason);
setInterval(() => {}, 1000);
`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    helper.stdout.on("data", (chunk) => (out += String(chunk)));
    helper.stderr.on("data", (chunk) => (out += String(chunk)));
    try {
      const deadline = Date.now() + 30_000;
      while (!/ready|failed/.test(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      console.info("[windows-ipc:exists-real] helper out=", JSON.stringify(out));
      expect(out).toContain("ready");
      expect(windowsMpvIpc.exists(`${endpoint}-absent`)).toBe(false);
      for (let i = 0; i < 50; i++) expect(windowsMpvIpc.exists(endpoint)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(out).not.toContain("connection");
    } finally {
      helper.kill();
    }
  }, 60_000);
});
