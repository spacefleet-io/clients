/**
 * @level unit
 * @req OPS-BIZ-20: an app says hello once per local day, with the app, platform and version header and its two
 *      tallies only (no Authorization, no id); a failure stays silent and keeps the tallies for the next hello; a
 *      2xx clears only what was sent; a dev build with no identity sends nothing.
 */
// @req OPS-BIZ-20[badger-desktop,badger-mobile,parrot]: every Badger and Parrot app says hello through this module.
import { beforeEach, describe, expect, it } from "vitest";
import { setClientIdentity } from "../src/appVersion";
import { __resetDailyHelloForTests, noteHelloPlay, noteHelloScreen, sayDailyHelloIfDue, type DailyHelloStore } from "../src/dailyHello";

const SUITE = "daily-hello";
const log = (step: string, value: unknown) => console.info(`[${SUITE}:${step}]`, JSON.stringify(value));

type Sent = { url: string; headers: Record<string, string>; body: unknown };

const setup = (status = 204) => {
  let stored: string | null = null;
  const store: DailyHelloStore = { read: () => stored, write: (value) => void (stored = value) };
  const sent: Sent[] = [];
  let answer = status;
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: answer });
  }) as unknown as typeof globalThis.fetch;
  return {
    store,
    sent,
    stored: () => (stored ? JSON.parse(stored) : null),
    answer: (next: number) => void (answer = next),
    options: (day: string) => ({ baseUrl: "https://api.test/", store, fetch, today: () => day }),
  };
};

describe("OPS-BIZ-20: daily hello", () => {
  beforeEach(() => {
    __resetDailyHelloForTests();
    setClientIdentity({ app: "badger", platform: "desktop", version: "0.2.0" });
  });

  it("sends once a day with the header and the tallies only", async () => {
    const t = setup();
    noteHelloPlay();
    noteHelloScreen();
    noteHelloScreen();
    expect(await sayDailyHelloIfDue(t.options("2026-11-22"))).toBe(true);
    expect(await sayDailyHelloIfDue(t.options("2026-11-22"))).toBe(true);
    log("sent", t.sent);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].url).toBe("https://api.test/usage/hello");
    expect(t.sent[0].headers).toEqual({ "x-space-client": "badger/desktop/0.2.0", "Content-Type": "application/json" });
    expect(t.sent[0].body).toEqual({ plays: 1, screens: 2 });
    expect(t.stored()).toEqual({ day: "2026-11-22", plays: 0, screens: 0 });
  });

  it("keeps the tallies after a failure and sends them with the next hello", async () => {
    const t = setup(503);
    noteHelloPlay();
    expect(await sayDailyHelloIfDue(t.options("2026-11-22"))).toBe(false);
    noteHelloPlay();
    t.answer(204);
    expect(await sayDailyHelloIfDue(t.options("2026-11-22"))).toBe(true);
    log("retry", { sent: t.sent, stored: t.stored() });
    expect(t.sent.map((entry) => entry.body)).toEqual([
      { plays: 1, screens: 0 },
      { plays: 2, screens: 0 },
    ]);
    noteHelloScreen();
    expect(await sayDailyHelloIfDue(t.options("2026-11-23"))).toBe(true);
    expect(t.sent[2].body).toEqual({ plays: 0, screens: 1 });
  });

  it("survives a network error and sends nothing without an identity", async () => {
    const t = setup();
    const throwing = { ...t.options("2026-11-22"), fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch };
    expect(await sayDailyHelloIfDue(throwing)).toBe(false);
    setClientIdentity(null);
    expect(await sayDailyHelloIfDue(t.options("2026-11-22"))).toBe(false);
    expect(t.sent).toHaveLength(0);
  });
});
