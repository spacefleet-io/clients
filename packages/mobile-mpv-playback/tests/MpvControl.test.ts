/**
 * @test-id MPV-CTRL-001
 * @level unit
 * @why MpvControl is the sole JS gate to the native libmpv bridge. When the
 *   native module is absent (any iOS run today, or a misconfigured Android
 *   build without autolinking), every method must throw a clear error rather
 *   than silently producing undefined behaviour. Vitest's Node env has no
 *   NativeModules, so no mocking is required — the fallback proxy fires
 *   unconditionally, which is exactly the condition we need to test.
 */
import { describe, expect, it, vi } from "vitest";

// NativeModules.MpvControl is undefined in Node — the module's own Proxy
// fallback is what we are testing.
vi.mock("react-native", () => ({
  NativeModules: {},
}));

import { MpvControl } from "../src/MpvControl";

console.info(
  `[mpv-control:setup] react-native mocked with empty NativeModules; ` +
    `MpvControl resolved via Proxy fallback (typeof=${typeof MpvControl})`,
);

// On assertion failure, dump enough state to diagnose offline (per the
// "Tests log generously" rule: tests must self-diagnose). Captures what was
// actually observed when invoking a fallback-Proxy method — the thrown error
// (or the unexpected return value when NOTHING was thrown, which is the most
// confusing failure mode). Wrapped in try/catch so a dump failure cannot mask
// the original assertion failure.
const dumpMpvControlSnapshot = (
  label: string,
  ctx: {
    method: string;
    threw: boolean;
    message?: string;
    returnedValue?: unknown;
    matcher?: string;
  },
) => {
  try {
    console.error(`=== [mpv-control:${label}] snapshot ===`);
    console.error(`method invoked: MpvControl.${ctx.method}`);
    console.error(`threw an error: ${ctx.threw}`);
    if (ctx.matcher) {
      console.error(`expected message to match: ${ctx.matcher}`);
    }
    if (ctx.threw) {
      console.error(`actual error message: ${JSON.stringify(ctx.message)}`);
    } else {
      console.error(
        `NO error thrown — fallback Proxy returned: ${JSON.stringify(ctx.returnedValue)}`,
      );
    }
    console.error(`NativeModules.MpvControl present: false (mocked empty)`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

// Invoke a fallback-Proxy method and capture whether/what it threw, so each
// test can dump real observed state on failure instead of leaving Vitest's
// bare "expected function to throw" message.
const invokeAndCapture = (
  method: string,
  call: () => unknown,
): { threw: boolean; message?: string; returnedValue?: unknown } => {
  try {
    const returnedValue = call();
    return { threw: false, returnedValue };
  } catch (err) {
    return { threw: true, message: err instanceof Error ? err.message : String(err) };
  }
};

describe("MpvControl — native module absent (autolink not run)", () => {
  it("togglePause() throws with an 'autolinked' hint", () => {
    console.info(`[mpv-control:togglePause] invoking fallback Proxy method`);
    const observed = invokeAndCapture("togglePause()", () => MpvControl.togglePause());
    if (!observed.threw || !/autolinked/i.test(observed.message ?? "")) {
      dumpMpvControlSnapshot("togglePause-bad-throw", {
        method: "togglePause()",
        matcher: "/autolinked/i",
        ...observed,
      });
    }
    expect(() => MpvControl.togglePause()).toThrow(/autolinked/i);
  });

  it("seek() throws with an 'autolinked' hint", () => {
    console.info(`[mpv-control:seek] invoking fallback Proxy method`);
    const observed = invokeAndCapture("seek(30, null)", () => MpvControl.seek(30, null));
    if (!observed.threw || !/autolinked/i.test(observed.message ?? "")) {
      dumpMpvControlSnapshot("seek-bad-throw", {
        method: "seek(30, null)",
        matcher: "/autolinked/i",
        ...observed,
      });
    }
    expect(() => MpvControl.seek(30, null)).toThrow(/autolinked/i);
  });

  it("loadFromUrl() throws with an 'autolinked' hint", () => {
    console.info(`[mpv-control:loadFromUrl] invoking fallback Proxy method`);
    const observed = invokeAndCapture("loadFromUrl(...)", () =>
      MpvControl.loadFromUrl("http://localhost/master.m3u8"),
    );
    if (!observed.threw || !/autolinked/i.test(observed.message ?? "")) {
      dumpMpvControlSnapshot("loadFromUrl-bad-throw", {
        method: "loadFromUrl('http://localhost/master.m3u8')",
        matcher: "/autolinked/i",
        ...observed,
      });
    }
    expect(() => MpvControl.loadFromUrl("http://localhost/master.m3u8")).toThrow(
      /autolinked/i
    );
  });

  it("getPlaybackState() throws with an 'autolinked' hint", () => {
    console.info(`[mpv-control:getPlaybackState] invoking fallback Proxy method`);
    const observed = invokeAndCapture("getPlaybackState()", () =>
      MpvControl.getPlaybackState(),
    );
    if (!observed.threw || !/autolinked/i.test(observed.message ?? "")) {
      dumpMpvControlSnapshot("getPlaybackState-bad-throw", {
        method: "getPlaybackState()",
        matcher: "/autolinked/i",
        ...observed,
      });
    }
    expect(() => MpvControl.getPlaybackState()).toThrow(/autolinked/i);
  });

  it("getTrackList() throws with an 'autolinked' hint", () => {
    console.info(`[mpv-control:getTrackList] invoking fallback Proxy method`);
    const observed = invokeAndCapture("getTrackList()", () => MpvControl.getTrackList());
    if (!observed.threw || !/autolinked/i.test(observed.message ?? "")) {
      dumpMpvControlSnapshot("getTrackList-bad-throw", {
        method: "getTrackList()",
        matcher: "/autolinked/i",
        ...observed,
      });
    }
    expect(() => MpvControl.getTrackList()).toThrow(/autolinked/i);
  });

  it("error message names the method that was called", () => {
    console.info(
      `[mpv-control:setAudioTrack] invoking fallback Proxy to assert the ` +
        `error message names the called method`,
    );
    let message = "";
    try {
      MpvControl.setAudioTrack(2);
    } catch (err) {
      message = (err as Error).message;
    }
    if (!/setAudioTrack/.test(message)) {
      dumpMpvControlSnapshot("setAudioTrack-message-missing-method", {
        method: "setAudioTrack(2)",
        matcher: "/setAudioTrack/",
        threw: message.length > 0,
        message,
      });
    }
    expect(message).toMatch(/setAudioTrack/);
  });
});
