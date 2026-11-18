import { describe, expect, it, vi } from "vitest";

import {
  buildGetPropertyCommand,
  buildSetPropertyCommand,
  getProperty,
  setProperty,
} from "../src/properties";

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real assertion. Surfaces the mock's recorded send calls (the wire
// shape actually emitted) alongside the actual vs expected return value.
const dumpPropertySnapshot = (
  label: string,
  ctx: { actual?: unknown; expected?: unknown; send?: ReturnType<typeof vi.fn> | null },
) => {
  try {
    console.error(`=== [mpv-protocol-properties:${label}] snapshot ===`);
    console.error(`actual=${JSON.stringify(ctx.actual)} expected=${JSON.stringify(ctx.expected)}`);
    if (ctx.send) {
      console.error(`send.mock.calls=${JSON.stringify(ctx.send.mock.calls, null, 2)}`);
      console.error(
        `send.mock.results=${JSON.stringify(ctx.send.mock.results.map((r) => r.type), null, 2)}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildGetPropertyCommand", () => {
  it("emits the canonical mpv get_property wire shape", () => {
    expect(buildGetPropertyCommand("time-pos")).toEqual({
      command: ["get_property", "time-pos"],
    });
    expect(buildGetPropertyCommand("track-list")).toEqual({
      command: ["get_property", "track-list"],
    });
    expect(buildGetPropertyCommand("sid")).toEqual({
      command: ["get_property", "sid"],
    });
  });
});

describe("buildSetPropertyCommand", () => {
  it("emits the canonical mpv set_property wire shape", () => {
    expect(buildSetPropertyCommand("pause", true)).toEqual({
      command: ["set_property", "pause", true],
    });
    expect(buildSetPropertyCommand("sid", 3)).toEqual({
      command: ["set_property", "sid", 3],
    });
    expect(buildSetPropertyCommand("sid", "no")).toEqual({
      command: ["set_property", "sid", "no"],
    });
    expect(buildSetPropertyCommand("volume", 75)).toEqual({
      command: ["set_property", "volume", 75],
    });
  });
});

describe("getProperty", () => {
  it("returns the typed data field on a successful response", async () => {
    console.info(`[mpv-protocol-properties:get-success] send resolves { data: 12.5 } for time-pos`);
    const send = vi.fn(async () => ({ data: 12.5 }));
    const value = await getProperty(send, "time-pos");
    console.info(`[mpv-protocol-properties:get-success] value=${JSON.stringify(value)}`);
    if (value !== 12.5) {
      dumpPropertySnapshot("get-success", { actual: value, expected: 12.5, send });
    }
    expect(value).toBe(12.5);
    expect(send).toHaveBeenCalledWith({ command: ["get_property", "time-pos"] });
  });

  it("returns null on real mpv error", async () => {
    console.info(`[mpv-protocol-properties:get-error] send resolves { error: "property unavailable" }`);
    const send = vi.fn(async () => ({ error: "property unavailable" }));
    const value = await getProperty(send, "time-pos");
    if (value !== null) {
      dumpPropertySnapshot("get-error", { actual: value, expected: null, send });
    }
    expect(value).toBe(null);
  });

  it('treats error="success" as ACK and surfaces the data field', async () => {
    console.info(`[mpv-protocol-properties:get-ack] send resolves { error: "success", data: false }`);
    const send = vi.fn(async () => ({ error: "success", data: false }));
    const value = await getProperty(send, "pause");
    if (value !== false) {
      dumpPropertySnapshot("get-ack", { actual: value, expected: false, send });
    }
    expect(value).toBe(false);
  });

  it("returns null on null/non-object responses", async () => {
    console.info(`[mpv-protocol-properties:get-nonobject] checking null + garbage-string responses`);
    const nullResult = await getProperty(async () => null, "time-pos");
    const garbageResult = await getProperty(async () => "garbage" as unknown, "time-pos");
    console.info(
      `[mpv-protocol-properties:get-nonobject] nullResult=${JSON.stringify(nullResult)} garbageResult=${JSON.stringify(garbageResult)}`,
    );
    if (nullResult !== null || garbageResult !== null) {
      dumpPropertySnapshot("get-nonobject", {
        actual: { nullResult, garbageResult },
        expected: { nullResult: null, garbageResult: null },
        send: null,
      });
    }
    expect(nullResult).toBe(null);
    expect(garbageResult).toBe(null);
  });

  it("returns null when the response is missing the data field", async () => {
    console.info(`[mpv-protocol-properties:get-missing-data] send resolves { error: "success" } with no data`);
    const send = vi.fn(async () => ({ error: "success" }));
    const value = await getProperty(send, "time-pos");
    if (value !== null) {
      dumpPropertySnapshot("get-missing-data", { actual: value, expected: null, send });
    }
    expect(value).toBe(null);
  });
});

describe("setProperty", () => {
  it('returns true on error="success"', async () => {
    console.info(`[mpv-protocol-properties:set-success] send resolves { error: "success" } for pause=true`);
    const send = vi.fn(async () => ({ error: "success" }));
    const ok = await setProperty(send, "pause", true);
    console.info(`[mpv-protocol-properties:set-success] ok=${ok}`);
    if (ok !== true) {
      dumpPropertySnapshot("set-success", { actual: ok, expected: true, send });
    }
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith({ command: ["set_property", "pause", true] });
  });

  it("returns true when the response carries no error field", async () => {
    console.info(`[mpv-protocol-properties:set-no-error] send resolves { data: null } (no error field)`);
    const send = vi.fn(async () => ({ data: null }));
    const ok = await setProperty(send, "mute", false);
    if (ok !== true) {
      dumpPropertySnapshot("set-no-error", { actual: ok, expected: true, send });
    }
    expect(ok).toBe(true);
  });

  it("returns false when mpv reports a real error", async () => {
    console.info(`[mpv-protocol-properties:set-error] send resolves { error: "invalid parameter" } for sid=99`);
    const send = vi.fn(async () => ({ error: "invalid parameter" }));
    const ok = await setProperty(send, "sid", 99);
    if (ok !== false) {
      dumpPropertySnapshot("set-error", { actual: ok, expected: false, send });
    }
    expect(ok).toBe(false);
  });

  it("returns false when the transport returns null", async () => {
    console.info(`[mpv-protocol-properties:set-null-transport] transport resolves null for pause=false`);
    const ok = await setProperty(async () => null, "pause", false);
    if (ok !== false) {
      dumpPropertySnapshot("set-null-transport", { actual: ok, expected: false, send: null });
    }
    expect(ok).toBe(false);
  });
});
