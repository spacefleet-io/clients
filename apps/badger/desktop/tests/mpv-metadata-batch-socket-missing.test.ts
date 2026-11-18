/**
 * @test-id MPV-METADATA-BATCH-SOCKET-MISSING-001
 *
 * [@bugfix][@regression-proof] run 7950 ingest-undefined-language "zero
 * unexpected console errors": 6 warnings `sendMetadata: failures {sent: 2,
 * failed: 2}` then `{sent: 0, failed: 4}` x2, the [0, 100, 300] backoff shape.
 * Every per-command failure was main's `{ error: "mpv_socket_missing" }` (the
 * mpv the batch targeted had been disposed / its socket file was gone), but
 * the batch only consulted the renderer lifecycle, which was still active
 * (launching / relaunch). It classified the batch as a real failure, warned per
 * attempt and kept retrying instead of stopping.
 */
import type { MpvCommand } from "@space/mpv-protocol";
import { describe, expect, it, vi } from "vitest";

import { sendMetadataBatch, sendMetadataWithBackoff, type UncheckedSendOutcome } from "../src/renderer/src/lib/mpvMetadataBackoff";

const TAG = "[mpv-metadata-batch-socket-missing]";

const metadataCommands: MpvCommand[] = [
  { command: ["script-message", "sf-labels-json", "{\"subtitlesOff\":\"Off\"}"] },
  { command: ["script-message", "sf-subtitles-json", "[]"] },
  { command: ["script-message", "sf-chapters-json", "[]"] },
  { command: ["script-message", "sf-playback-json", "{}"] },
];

const recordingLog = (name: string, sink: string[]) => {
  const entry = (level: string) => (fields: Record<string, unknown>, message: string) => {
    sink.push(`${name}.${level}: ${message} ${JSON.stringify(fields)}`);
  };
  return { debug: entry("debug"), info: entry("info"), warn: entry("warn") };
};

const runBatch = async (outcomes: UncheckedSendOutcome[], lifecycleActive: () => boolean) => {
  const lines: string[] = [];
  const queue = [...outcomes];
  const send = vi.fn(async (_command: MpvCommand) => queue.shift() ?? "ok");
  const result = await sendMetadataBatch(metadataCommands, send, lifecycleActive, {
    subPipeline: recordingLog("subPipeline", lines),
    playbackDebug: recordingLog("playbackDebug", lines),
  });
  return { result, lines, sends: send.mock.calls.length };
};

describe("[@bugfix][@regression-proof] metadata batch: mpv_socket_missing while the lifecycle is still active", () => {
  it("mid-batch socket-missing (mpv disposed during relaunch) is socketMissing and logs no warning", async () => {
    const { result, lines, sends } = await runBatch(["ok", "ok", "socket-missing", "socket-missing"], () => true);
    console.info(`${TAG} mid-batch result=${JSON.stringify(result)} sends=${sends}\n  ${lines.join("\n  ")}`);
    expect(result.socketMissing).toBe(true);
    expect(lines.filter((line) => line.includes(".warn:"))).toEqual([]);
  });

  it("the backoff stops after the first socket-missing attempt instead of retrying 3 times", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      let attempts = 0;
      const pending = sendMetadataWithBackoff(() => {
        attempts += 1;
        return sendMetadataBatch(metadataCommands, async () => "socket-missing", () => true, {
          subPipeline: recordingLog("subPipeline", lines),
          playbackDebug: recordingLog("playbackDebug", lines),
        });
      });
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;
      console.info(`${TAG} backoff attempts=${attempts} result=${JSON.stringify(result)}\n  ${lines.join("\n  ")}`);
      expect(attempts).toBe(1);
      expect(lines.filter((line) => line.includes(".warn:"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a real mpv command error on a live socket still warns and is retryable", async () => {
    const { result, lines } = await runBatch(["ok", "failed", "ok", "ok"], () => true);
    console.info(`${TAG} real-error result=${JSON.stringify(result)}\n  ${lines.join("\n  ")}`);
    expect(result).toEqual({ sent: 3, failed: 1, socketMissing: false });
    expect(lines.filter((line) => line.includes(".warn:"))).toHaveLength(2);
  });

  it("failures after the lifecycle went inactive stay socketMissing (unchanged)", async () => {
    let active = true;
    const lines: string[] = [];
    const result = await sendMetadataBatch(
      metadataCommands,
      async () => {
        active = false;
        return "failed";
      },
      () => active,
      { subPipeline: recordingLog("subPipeline", lines), playbackDebug: recordingLog("playbackDebug", lines) },
    );
    console.info(`${TAG} inactive result=${JSON.stringify(result)}\n  ${lines.join("\n  ")}`);
    expect(result).toEqual({ sent: 0, failed: 1, socketMissing: true });
    expect(lines.filter((line) => line.includes(".warn:"))).toEqual([]);
  });
});
