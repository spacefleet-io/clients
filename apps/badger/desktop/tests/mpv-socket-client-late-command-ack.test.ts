/**
 * @bugfix mpv-script-message-ack-1s-cap
 * @regression-proof
 *
 * `playback-subtitle-switch` failed under load on its console guard:
 * `sendUnchecked: mpv returned error … cmdKind: script-message:sf-audio-json, error: mpv_request_timeout`.
 * mpv answers a JSON-IPC command only once its core thread has run it; on a loaded host that thread is busy for
 * more than a second (file open, video output reconfig) and the answer came after UnixSocketMpvClient's 1 s cap.
 * The command still landed, but the renderer was told it failed.
 *
 * Fix: a `script-message` sent with `command()` waits up to 5 s for mpv's ACK, which carries nothing a caller decides
 * on. Queries and other commands (loadfile, quit) keep the 1 s cap: their callers act on the answer in bounded time.
 *
 * Real timers and a real Unix socket on purpose: the bug is the race between mpv's late answer and the client's
 * timer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGetPropertyCommand, buildLoadfileCommand, buildScriptMessageCommand } from "@space/mpv-protocol";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-late-command-ack]";
const ANSWER_DELAY_MS = 1500;

type LateMpv = { log: string[]; stop: () => Promise<void> };

/** A fake mpv that answers every request `delayMs` late, like a busy core thread. */
const startLateMpv = async (socketPath: string, delayMs: number): Promise<LateMpv> => {
  const log: string[] = [];
  const server: Server = createServer((client) => {
    let buffer = "";
    client.on("error", () => undefined);
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { request_id?: number; command?: unknown[] };
        log.push(`recv ${JSON.stringify(message.command)}`);
        if (typeof message.request_id !== "number") continue;
        setTimeout(() => {
          if (client.destroyed) {
            log.push(`answer dropped (client gone) request_id=${message.request_id}`);
            return;
          }
          client.write(`${JSON.stringify({ request_id: message.request_id, error: "success", data: 1 })}\n`);
          log.push(`answered request_id=${message.request_id} after ${delayMs}ms`);
        }, delayMs);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { log, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

describe("mpv command ACK cap (sendUnchecked mpv_request_timeout under load)", () => {
  const socketPath = join(tmpdir(), `sf-mpv-late-ack-${process.pid}-${Date.now()}.sock`);
  let fake: LateMpv | null = null;

  const attachClient = () => {
    const client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-playback state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    return client;
  };

  beforeEach(async () => {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    fake = await startLateMpv(socketPath, ANSWER_DELAY_MS);
  });

  afterEach(async () => {
    console.info(`${TAG} fake mpv log:\n  ${fake?.log.join("\n  ") ?? "(none)"}`);
    await fake?.stop();
    fake = null;
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  it("@bugfix @regression-proof a script-message mpv acknowledges after 1.5 s is a success, not mpv_request_timeout", async () => {
    const client = attachClient();
    const startedAt = Date.now();
    const reply = await client
      .command(buildScriptMessageCommand("sf-audio-json", [{ title: "French", label: "FRE", lang: "fre" }]))
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    console.info(`${TAG} command reply after ${Date.now() - startedAt}ms: ${JSON.stringify(reply)}`);
    expect(reply.error).toBe("success");
  }, 10_000);

  it("a query answered after 1.5 s still times out at the 1 s request cap", async () => {
    const client = attachClient();
    const startedAt = Date.now();
    const reply = await client
      .request(buildGetPropertyCommand("time-pos"))
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const elapsedMs = Date.now() - startedAt;
    console.info(`${TAG} request reply after ${elapsedMs}ms: ${JSON.stringify(reply)}`);
    expect(reply.error).toBe("mpv_request_timeout");
    expect(elapsedMs).toBeLessThan(ANSWER_DELAY_MS);
  }, 10_000);

  it("a loadfile answered after 1.5 s still times out at the 1 s cap (its callers fall back to mpv's events)", async () => {
    const client = attachClient();
    const startedAt = Date.now();
    const reply = await client
      .command(buildLoadfileCommand("https://example.invalid/master.m3u8", "replace", { startSeconds: 0 }))
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const elapsedMs = Date.now() - startedAt;
    console.info(`${TAG} loadfile reply after ${elapsedMs}ms: ${JSON.stringify(reply)}`);
    expect(reply.error).toBe("mpv_request_timeout");
    expect(elapsedMs).toBeLessThan(ANSWER_DELAY_MS);
  }, 10_000);
});
