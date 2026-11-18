// @vitest-environment jsdom
/**
 * BADGER-DESKTOP-STREAM-SLOT-001
 * @level integration (the renderer's gate factory `lib/streamSlot.ts` over the real `@space/stream-slots` client with a
 * fake `fetch` speaking the API's answers, and the shared prompt `@space/ui/stream-slot-prompt` it drives)
 * @req ACCT-STREAM-01[badger-desktop]
 * @req ACCT-STREAM-02[badger-desktop]
 * @req ACCT-STREAM-03[badger-desktop]
 * @req ACCT-STREAM-04[badger-desktop]
 *
 * The account's stream limit on Badger desktop: a streamed film asks for a place first (app `badger`, the active
 * profile), at the limit the window asks "Already playing on {device}. Play here instead?" (Play here takes over,
 * Cancel takes nothing and closes the player), a heartbeat answered "taken over" closes the player and says
 * "Playing on {device} now", and closing the player gives the place back. A downloaded copy never reaches the gate
 * (`useMpvPlaybackEngine` releases instead of acquiring), which the last case pins at the gate's side.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamSlotsClient, streamSlotText } from "@space/stream-slots";
import { StreamSlotPrompt, useStreamSlotState } from "@space/ui/stream-slot-prompt";
import { createDesktopStreamSlot, type DesktopStreamSlot } from "../src/renderer/src/lib/streamSlot";

const SUITE = "[BADGER-DESKTOP-STREAM-SLOT-001]";
const API = "http://api.test";
const PROFILE = "p-main";

type Call = { method: string; url: string; body: Record<string, unknown> | null; auth: string | null };
type Reply = { status: number; body: unknown };

const started = (streamId: string): Reply => ({
  status: 201,
  body: { streamId, profileId: PROFILE, heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});
const atLimit = (deviceName: string | null, deviceType = "tv"): Reply => ({
  status: 409,
  body: { error: "stream_limit", limit: 1, playingOn: [{ streamId: "other", deviceName, deviceType, startedAt: "2026-11-11T01:00:00Z" }] },
});
const takenOver = (deviceName: string): Reply => ({
  status: 409,
  body: { error: "stream_taken_over", byDeviceName: deviceName, byDeviceType: "phone" },
});

let calls: Call[];
let starts: Reply[];
let beats: Reply[];
let intervals: Array<() => void>;
let closes: number;
let root: Root | null;
let host: HTMLElement | null;

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ method, url, body, auth: new Headers(init?.headers).get("authorization") });
  let reply: Reply = { status: 204, body: null };
  if (method === "POST" && url.endsWith("/playback/streams")) reply = starts.shift() ?? { status: 500, body: { error: "no start reply queued" } };
  else if (url.endsWith("/heartbeat")) reply = beats.shift() ?? { status: 200, body: { expiresInSeconds: 60 } };
  console.info(`${SUITE} api ${method} ${url} ${JSON.stringify(body)} -> ${reply.status}`);
  return new Response(reply.body === null ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
});

const makeSlot = (): DesktopStreamSlot =>
  createDesktopStreamSlot({
    client: createStreamSlotsClient({ baseUrl: API, getToken: () => "desk-token", fetch: fakeFetch as unknown as typeof fetch }),
    getProfileId: () => PROFILE,
    closePlayback: () => {
      closes += 1;
    },
    timers: {
      setInterval: (callback) => {
        intervals.push(callback);
        return intervals.length - 1;
      },
      clearInterval: (handle) => {
        intervals[handle as number] = () => undefined;
      },
    },
  });

type Slot = DesktopStreamSlot;

function Prompt({ slot }: { slot: Slot }) {
  return (
    <StreamSlotPrompt
      state={useStreamSlotState(slot.gate)}
      language="en"
      closeLabel="Close"
      onAnswer={(answer) => slot.gate.answer(answer)}
      onDismiss={() => slot.gate.dismiss()}
    />
  );
}

const mount = async (slot: Slot) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Prompt slot={slot} />));
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => await Promise.resolve());
};

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const streamPosts = () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/playback/streams"));

beforeEach(() => {
  calls = [];
  starts = [];
  beats = [];
  intervals = [];
  closes = 0;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("Badger desktop player obeys the account's stream limit", () => {
  it("@req ACCT-STREAM-01[badger-desktop] a streamed film takes a place for the active profile and reuses it; closing gives it back", async () => {
    const slot = makeSlot();
    starts.push(started("s1"));
    expect(await slot.acquire()).toBe("play");
    console.info(`${SUITE} phase.started ${JSON.stringify(calls)}`);
    expect(streamPosts()).toHaveLength(1);
    expect(streamPosts()[0]).toMatchObject({
      url: `${API}/playback/streams`,
      body: { app: "badger", profileId: PROFILE, kind: "play", takeover: false },
      auth: "Bearer desk-token",
    });
    expect(slot.gate.getState().kind).toBe("playing");

    // Next episode / format reload: the place already held is reused, no second request.
    expect(await slot.acquire()).toBe("play");
    expect(streamPosts()).toHaveLength(1);

    // ACCT-STREAM-04: the player closed (engine teardown) → the place goes back at once.
    await slot.release();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${API}/playback/streams/s1` });
    expect(slot.gate.getState().kind).toBe("idle");
    expect(closes).toBe(0);
  });

  it("@req ACCT-STREAM-02[badger-desktop] at the limit the window asks 'Play here instead?' and Play here takes the place over", async () => {
    const slot = makeSlot();
    await mount(slot);
    starts.push(atLimit("Living room TV"), started("s2"));
    const answer = slot.acquire();
    await settle();
    const prompt = byTestId("stream-slot-prompt");
    console.info(`${SUITE} phase.asked ${prompt?.textContent}`);
    expect(prompt?.textContent).toContain(streamSlotText("en", "alreadyPlaying", { deviceName: "Living room TV", deviceType: "tv" }));
    expect(byTestId("stream-slot-play-here")?.textContent).toBe("Play here");
    expect(byTestId("stream-slot-cancel")?.textContent).toBe("Cancel");

    await act(async () => byTestId("stream-slot-play-here")?.click());
    expect(await answer).toBe("play");
    await settle();
    expect(streamPosts().map((call) => call.body?.takeover)).toEqual([false, true]);
    expect(slot.gate.getState().kind).toBe("playing");
    expect(byTestId("stream-slot-prompt")).toBeNull();
    expect(closes).toBe(0);
  });

  it("@req ACCT-STREAM-02[badger-desktop] Cancel takes nothing over and closes the player", async () => {
    const slot = makeSlot();
    await mount(slot);
    starts.push(atLimit(null, "phone"));
    const answer = slot.acquire();
    await settle();
    expect(byTestId("stream-slot-prompt")?.textContent).toContain(streamSlotText("en", "alreadyPlaying", { deviceName: null, deviceType: "phone" }));

    await act(async () => byTestId("stream-slot-cancel")?.click());
    expect(await answer).toBe("cancel");
    await settle();
    console.info(`${SUITE} phase.cancelled ${JSON.stringify(calls)}`);
    expect(streamPosts()).toHaveLength(1);
    expect(closes).toBe(1);
    expect(slot.gate.getState().kind).toBe("idle");
    expect(byTestId("stream-slot-prompt")).toBeNull();
  });

  it("@req ACCT-STREAM-02[badger-desktop] another device taking the place over closes the player and says where it plays now", async () => {
    const slot = makeSlot();
    await mount(slot);
    starts.push(started("s3"));
    expect(await slot.acquire()).toBe("play");
    beats.push(takenOver("Kitchen phone"));
    await act(async () => intervals[0]?.());
    await settle();
    const prompt = byTestId("stream-slot-prompt");
    console.info(`${SUITE} phase.taken-over ${prompt?.textContent}`);
    expect(closes).toBe(1);
    expect(prompt?.textContent).toContain(streamSlotText("en", "playingElsewhere", { deviceName: "Kitchen phone", deviceType: "phone" }));
    await act(async () => byTestId("stream-slot-close")?.click());
    expect(byTestId("stream-slot-prompt")).toBeNull();
    expect(slot.gate.getState().kind).toBe("idle");
  });

  it("@req ACCT-STREAM-03[badger-desktop] a release with no place held (a downloaded copy) sends nothing", async () => {
    const slot = makeSlot();
    await slot.release();
    expect(calls).toEqual([]);
    expect(slot.gate.getState().kind).toBe("idle");
  });
});
