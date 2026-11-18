/**
 * @bugfix mpv-time-pos-ipc-throttle
 * @regression-proof
 *
 * Issue #25 (playback must cost no more than plain local mpv): mpv pushes
 * `time-pos` once per displayed frame, and main forwarded EVERY push to the
 * renderer over `sf-mpv-external-message` (~60 IPC messages/s at 60 fps) while
 * the renderer coalesces it to 250 ms anyway. The forwarding source is the
 * UnixSocketMpvClient "property-change" event (externalMpv.ts relays each one).
 *
 * Lowest layer that shows it: the real UnixSocketMpvClient fed by a mock mpv
 * socket pushing time-pos at 60 Hz on a fake clock (Date + setTimeout only; the
 * socket stays real and every push is awaited via an in-order sentinel). Pre-fix: one "property-change"
 * per push. Post-fix: one per window, the trailing value always delivered, and
 * every other property / event stays immediate and ordered after the exact
 * position.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-time-pos-ipc-throttle]";
const FRAME_MS = 1000 / 60;

const cleanupSocket = (path: string) => {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
};

type MockMpv = { firstCommand: Promise<void>; push: (event: unknown) => void; stop: () => Promise<void> };

const startMockMpv = async (socketPath: string): Promise<MockMpv> => {
  cleanupSocket(socketPath);
  const connections: Socket[] = [];
  const first = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<void>();
  const server: Server = createServer((conn) => {
    connections.push(conn);
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: { request_id?: unknown };
        try {
          parsed = JSON.parse(line) as { request_id?: unknown };
        } catch {
          continue;
        }
        first.resolve();
        if (typeof parsed.request_id === "number") {
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
        }
      }
    });
  });
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  return {
    firstCommand: first.promise,
    push: (event: unknown) => {
      for (const conn of connections) conn.write(`${JSON.stringify(event)}\n`);
    },
    stop: async () => {
      for (const conn of connections) conn.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      cleanupSocket(socketPath);
    },
  };
};

type Emitted = { name: string; value: unknown };

describe("time-pos property-change is rate-limited on its way out of main (#25)", () => {
  let socketPath: string;
  let mock: MockMpv;
  let client: UnixSocketMpvClient;
  let emitted: Emitted[];
  let sentinelSeq: number;
  const sentinels = new Map<number, () => void>();

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-mpv-timepos-${process.pid}-${Date.now()}.sock`);
    mock = await startMockMpv(socketPath);
    client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-launch state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    emitted = [];
    sentinelSeq = 0;
    client.on("property-change", (event) => {
      if (event.name !== "duration") emitted.push({ name: event.name, value: event.value });
    });
    // `duration` carries the in-order delivery sentinel: socket reads are ordered,
    // so once seq N came back, everything pushed before it was routed.
    client.observe("duration", (value) => sentinels.get(value as number)?.());
    for (const property of ["time-pos", "pause", "eof-reached"] as const) {
      client.observe(property, () => undefined);
    }
    await mock.firstCommand;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client.dispose();
    await mock.stop();
  });

  /** Push one mpv event and resolve once the client has routed it. */
  const deliver = async (event: unknown): Promise<void> => {
    const seq = (sentinelSeq += 1);
    const routed = Promise.withResolvers<void>();
    sentinels.set(seq, () => routed.resolve());
    mock.push(event);
    mock.push({ event: "property-change", name: "duration", data: seq });
    await routed.promise;
    sentinels.delete(seq);
  };

  const timePosEvent = (value: number) => ({ event: "property-change", name: "time-pos", data: value });

  /** 60 Hz time-pos for `ms` of fake time; returns the last value pushed. */
  const playFor = async (ms: number): Promise<number> => {
    const frames = Math.floor((ms * 60) / 1000);
    let last = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      last = 100 + frame / 60;
      await deliver(timePosEvent(last));
      vi.advanceTimersByTime(1000 / 60);
    }
    console.info(`${TAG} pushed ${frames} time-pos over ${ms} ms (${((frames * 1000) / ms).toFixed(0)}/s)`);
    return last;
  };

  const timePos = () => emitted.filter((e) => e.name === "time-pos");

  it("60 time-pos pushes/s reach the renderer at <= ~4/s and the final value is delivered", async () => {
    const lastPushed = await playFor(2000);
    vi.advanceTimersByTime(400);
    const got = timePos();
    console.info(`${TAG} emitted=${got.length} first=${String(got[0]?.value)} last=${String(got.at(-1)?.value)} lastPushed=${lastPushed}`);
    // 2 s at a 250 ms window = 8 windows (+ leading edge slack).
    expect(got.length, "time-pos IPC emits for 2 s of 60 fps playback").toBeLessThanOrEqual(9);
    expect(got.length).toBeGreaterThanOrEqual(7);
    expect(got.at(-1)?.value, "trailing value is the last pushed").toBe(lastPushed);
  });

  it("a hidden-window interval (1 s) cuts emits further and still delivers the trailing value", async () => {
    client.timePosEmitWindowMs = () => 1000;
    const lastPushed = await playFor(2000);
    vi.advanceTimersByTime(1200);
    const got = timePos();
    console.info(`${TAG} hidden emitted=${got.length} last=${String(got.at(-1)?.value)} lastPushed=${lastPushed}`);
    expect(got.length, "time-pos IPC emits for 2 s hidden").toBeLessThanOrEqual(3);
    expect(got.at(-1)?.value).toBe(lastPushed);
  });

  it("a value waiting on the hidden window is released when the window is shown again", async () => {
    let windowMs = 1000;
    client.timePosEmitWindowMs = () => windowMs;
    await deliver(timePosEvent(1));
    vi.advanceTimersByTime(300);
    await deliver(timePosEvent(2));
    expect(timePos().map((e) => e.value), "hidden: 2 is held back").toEqual([1]);
    windowMs = 250;
    await deliver(timePosEvent(3));
    console.info(`${TAG} after show: ${JSON.stringify(timePos())}`);
    expect(timePos().map((e) => e.value), "visible: the next push is released at once").toEqual([1, 3]);
  });

  it("pause and eof-reached stay immediate and arrive AFTER the exact position", async () => {
    await deliver(timePosEvent(10));
    vi.advanceTimersByTime(30);
    await deliver(timePosEvent(10.1));
    await deliver(timePosEvent(10.2));
    await deliver({ event: "property-change", name: "pause", data: true });
    vi.advanceTimersByTime(40);
    await deliver(timePosEvent(55));
    await deliver({ event: "property-change", name: "eof-reached", data: true });
    console.info(`${TAG} sequence=${JSON.stringify(emitted)}`);
    expect(emitted).toEqual([
      { name: "time-pos", value: 10 },
      { name: "time-pos", value: 10.2 },
      { name: "pause", value: true },
      { name: "time-pos", value: 55 },
      { name: "eof-reached", value: true },
    ]);
  });

  it("a pending time-pos is delivered, not dropped, when the file ends", async () => {
    client.on("end-file", () => emitted.push({ name: "end-file", value: null }));
    await deliver(timePosEvent(1));
    vi.advanceTimersByTime(30);
    await deliver(timePosEvent(99.5));
    await deliver({ event: "end-file", reason: "eof" });
    console.info(`${TAG} sequence=${JSON.stringify(emitted)}`);
    expect(emitted).toEqual([
      { name: "time-pos", value: 1 },
      { name: "time-pos", value: 99.5 },
      { name: "end-file", value: null },
    ]);
  });
});
