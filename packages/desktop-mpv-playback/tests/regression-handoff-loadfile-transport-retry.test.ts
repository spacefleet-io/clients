// @bugfix @regression-proof issue #25 NEW-handoff-teardown-race (ultimate run
// 1791422679313, S1 c038).
//
// Evidence (shard-1/timeline.jsonl, c038):
//   window hidden for the backdrop->stream handoff
//   +37 ms  loadStream: backdrop->stream load FAILED {swapMs: 37, settledBy: reply}
//   +49 ms  main: renderer requested external mpv stop {hadClient: true}
//   mpv's own log never shows the `loadfile`; 11 IPC connections were accepted
//   in one burst on the throttled CPU.
//
// The handoff `loadfile` reply did not come from mpv (no `request_id`: an IPC
// connect/write error from main), yet it was treated as mpv rejecting the
// file, and the handoff stopped mpv before a first frame. Fix: a reply that
// never came from mpv re-sends the `loadfile`; only mpv's own error reply (or a
// failing end-file) fails the load.
import { describe, expect, it } from "vitest";
import { awaitHandoffLoadfile, isLoadfileTransportFailure, type ExternalLoadVerdict } from "../src/index";

const TAG = "[regression-handoff-loadfile-transport-retry]";

const never = <T>() => new Promise<T>(() => {});

describe("handoff loadfile transport retry (@bugfix @regression-proof issue #25 NEW-handoff-teardown-race)", () => {
  it("replays c038: an IPC connect error re-sends the loadfile instead of tearing the handoff down", async () => {
    const sent: string[] = [];
    const resend = () => {
      sent.push("resend");
      return Promise.resolve({ error: "success", request_id: 1, data: null });
    };
    const outcome = await awaitHandoffLoadfile({
      reply: Promise.resolve({ error: "connect EAGAIN /tmp/spacebadger-mpv.sock" }),
      resend,
      retryDelaysMs: [1, 1],
      fileLoaded: never<void>(),
      endFileFailure: never<ExternalLoadVerdict>(),
    });
    console.info(TAG, "c038 replay", JSON.stringify(outcome));
    expect(sent).toEqual(["resend"]);
    expect(outcome.verdict.failed).toBe(false);
    expect(outcome.settledBy).toBe("reply");
    expect(outcome.transportRetries).toBe(1);
  });

  it("a thrown IPC error is retried the same way", async () => {
    let resends = 0;
    const outcome = await awaitHandoffLoadfile({
      reply: Promise.reject(new Error("write EPIPE")),
      resend: () => {
        resends += 1;
        return Promise.resolve({ error: "success", request_id: 7 });
      },
      retryDelaysMs: [1, 1],
      fileLoaded: never<void>(),
      endFileFailure: never<ExternalLoadVerdict>(),
    });
    console.info(TAG, "thrown transport error", JSON.stringify(outcome));
    expect(resends).toBe(1);
    expect(outcome.verdict.failed).toBe(false);
    expect(outcome.transportRetries).toBe(1);
  });

  it("mpv's own error reply is final: not re-sent, the load fails", async () => {
    let resends = 0;
    const outcome = await awaitHandoffLoadfile({
      reply: Promise.resolve({ error: "invalid parameter", request_id: 1 }),
      resend: () => {
        resends += 1;
        return Promise.resolve({ error: "success", request_id: 2 });
      },
      retryDelaysMs: [1, 1],
      fileLoaded: never<void>(),
      endFileFailure: never<ExternalLoadVerdict>(),
    });
    console.info(TAG, "mpv rejection", JSON.stringify(outcome));
    expect(resends).toBe(0);
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "loadfile_rejected" });
    expect(outcome.transportRetries).toBeUndefined();
  });

  it("fails once the retries are spent and reports how many were made", async () => {
    let resends = 0;
    const outcome = await awaitHandoffLoadfile({
      reply: Promise.resolve({ error: "connect ECONNREFUSED" }),
      resend: () => {
        resends += 1;
        return Promise.resolve({ error: "connect ECONNREFUSED" });
      },
      retryDelaysMs: [1, 1],
      fileLoaded: never<void>(),
      endFileFailure: never<ExternalLoadVerdict>(),
    });
    console.info(TAG, "retries exhausted", JSON.stringify(outcome));
    expect(resends).toBe(2);
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "loadfile_rejected" });
    expect(outcome.transportRetries).toBe(2);
  });

  it("a reply timeout stays unknown and is not re-sent (P17 contract)", async () => {
    let resends = 0;
    const outcome = await awaitHandoffLoadfile({
      reply: Promise.resolve({ error: "mpv_request_timeout" }),
      resend: () => {
        resends += 1;
        return Promise.resolve({ error: "success", request_id: 2 });
      },
      retryDelaysMs: [1, 1],
      fileLoaded: Promise.resolve(),
      endFileFailure: never<ExternalLoadVerdict>(),
    });
    expect(resends).toBe(0);
    expect(outcome.verdict.failed).toBe(false);
    expect(outcome.settledBy).toBe("file_loaded");
  });

  it("classifies transport failures by the missing mpv request_id", () => {
    expect(isLoadfileTransportFailure(null)).toBe(true);
    expect(isLoadfileTransportFailure(undefined)).toBe(true);
    expect(isLoadfileTransportFailure({ error: "connect EAGAIN" })).toBe(true);
    expect(isLoadfileTransportFailure({ error: "success", request_id: 1 })).toBe(false);
    expect(isLoadfileTransportFailure({ error: "invalid parameter", request_id: 1 })).toBe(false);
    expect(isLoadfileTransportFailure({ error: "mpv_request_timeout" })).toBe(false);
  });
});
