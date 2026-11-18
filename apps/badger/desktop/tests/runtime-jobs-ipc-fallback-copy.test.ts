/**
 * #25 (Chris 2026-10-09, reworked 2026-10-13): this computer's "fallback 360p
 * copy" is the ONLY thing that decides whether adding media makes a 360p copy:
 * OFF → the automatic ladder is empty, ON → exactly [360p]. Extra qualities
 * picked in Settings are kept, and a quality the user explicitly asks for
 * (replan_qualities, e.g. Add quality → 480p) still goes through.
 *
 * Drives the real main-process IPC handlers with electron + runtime-client
 * mocked, and asserts on the exact command payloads sent to the runtime.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRuntimeJobsIpc, setRuntimeJobsBackendToken } from "../src/main/runtimeJobsIpc";

const P = "[runtime-jobs-ipc-fallback-copy]";

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
type SentCommand = { payload: Record<string, unknown> };

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  sent: [] as Array<{ payload: Record<string, unknown> }>,
  fallbackCopy: false,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn);
    },
  },
}));

vi.mock("@space/runtime-client/session", () => ({
  createRuntimeSession: () => ({ getToken: async () => "session-token" }),
}));

vi.mock("@space/runtime-client/command", () => ({
  createRuntimeCommandClient: () => ({
    sendCommand: async (_contract: unknown, payload: Record<string, unknown>) => {
      console.info(`[runtime-jobs-ipc-fallback-copy]:sendCommand payload=${JSON.stringify(payload)}`);
      state.sent.push({ payload });
      return { submitted: [], addedJobIds: [] };
    },
  }),
}));

const dumpSent = (label: string) => {
  console.error(`=== ${P}:${label} sent commands ===\n${JSON.stringify(state.sent, null, 2)}\n=== end ===`);
};

const handler = (channel: string): Handler => {
  const fn = state.handlers.get(channel);
  if (!fn) console.error(`${P} missing handler ${channel}; registered=${[...state.handlers.keys()].join(",")}`);
  expect(fn, `${channel} handler registered`).toBeTypeOf("function");
  return fn as Handler;
};

const submit = async (desiredFormats: string[] | undefined): Promise<unknown> => {
  await handler("sf-runtime-jobs-submit-sources")({}, {
    userId: "u1",
    sources: [{ filename: "/media/Orchard (2017).mkv", sizeMb: 900, desiredFormats }],
  });
  const call: SentCommand | undefined = state.sent.find((s) => Array.isArray(s.payload.sources));
  if (!call) dumpSent("submit-missing");
  const sources = call?.payload.sources as Array<{ desiredFormats: string[] }> | undefined;
  return sources?.[0]?.desiredFormats;
};

beforeAll(() => {
  registerRuntimeJobsIpc({
    runtimeBaseUrl: "http://127.0.0.1:3020",
    getFallbackCopy: async () => {
      console.info(`${P}:getFallbackCopy -> ${state.fallbackCopy}`);
      return state.fallbackCopy;
    },
  });
  setRuntimeJobsBackendToken("backend-token");
  console.info(`${P}:setup handlers=${[...state.handlers.keys()].join(",")}`);
});

beforeEach(() => {
  state.sent.length = 0;
});

describe("ingest submit honours this computer's fallback 360p copy", () => {
  it("OFF: no automatic copy at all, even if the account ladder lists 360p or a stale 480p", async () => {
    state.fallbackCopy = false;
    const formats = await submit(["480p", "360p"]);
    console.info(`${P}:off formats=${JSON.stringify(formats)}`);
    if (JSON.stringify(formats) !== JSON.stringify([])) dumpSent("off");
    expect(formats).toEqual([]);
  });

  it("ON: exactly one 360p copy", async () => {
    state.fallbackCopy = true;
    const formats = await submit(["360p"]);
    console.info(`${P}:on formats=${JSON.stringify(formats)}`);
    if (JSON.stringify(formats) !== JSON.stringify(["360p"])) dumpSent("on");
    expect(formats).toEqual(["360p"]);
  });

  it("a renderer that sends no ladder gets [] when OFF and [360p] when ON", async () => {
    state.fallbackCopy = false;
    const off = await submit(undefined);
    state.sent.length = 0;
    state.fallbackCopy = true;
    const on = await submit(undefined);
    console.info(`${P}:no-ladder off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
    expect(off).toEqual([]);
    expect(on).toEqual(["360p"]);
  });

  it("@req INGS-FALLBK-01 @req ACCT-SQUAD-03[badger-desktop] ON makes the account's further qualities and 360p; OFF makes none of them", async () => {
    state.fallbackCopy = true;
    const on = await submit(["720p"]);
    state.sent.length = 0;
    state.fallbackCopy = false;
    const off = await submit(["720p"]);
    console.info(`${P}:extras on=${JSON.stringify(on)} off=${JSON.stringify(off)}`);
    expect(on).toEqual(["720p", "360p"]);
    expect(off).toEqual([]);
  });

  it("OFF: an explicitly requested 480p (replan) still goes through", async () => {
    state.fallbackCopy = false;
    await handler("sf-badger-media-replan-qualities")({}, {
      mediaId: "m1",
      fileId: "f1",
      addQualities: ["480p"],
      removeFormatIds: [],
    });
    const call = state.sent.find((s) => Array.isArray(s.payload.addQualities));
    console.info(`${P}:replan call=${JSON.stringify(call)}`);
    if (!call) dumpSent("replan-missing");
    expect(call?.payload.addQualities).toEqual(["480p"]);
  });
});
