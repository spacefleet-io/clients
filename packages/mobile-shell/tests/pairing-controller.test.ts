/**
 * @test-id TV-PAIR-CONTROLLER-001
 * @level unit
 * @why The TV sign-in screen has nobody to press a button: the controller must renew an expired code by itself,
 *   stop on denial, report each failure with its own reason, and never touch state after the screen is left.
 *   Driven by a scripted client and a virtual clock.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_POLL_FAILURES,
  MIN_RENEW_GAP_MS,
  createPairingController,
  type PairingCompletion,
  type PairingState,
} from "../src/pairing";
import { PairingHttpError, type PairingClientCore, type PairingCreated, type PairingPoll } from "@space/pairing-crypto";

const APPROVED: PairingPoll = { status: "approved", token: "t", user: { id: "u1", email: "a@b.test" }, libraryKey: "a2V5" };

type Script = {
  starts: Array<PairingCreated | Error>;
  polls: Array<PairingPoll | Error | (() => Promise<PairingPoll>)>;
};

const created = (n: number, expiresAt: number): PairingCreated => ({
  requestId: `req-${n}`,
  shortCode: `CODE-000${n}`,
  qrPayload: `https://spacefleet.io/pair/badger?code=${n}`,
  expiresAt: new Date(expiresAt).toISOString(),
  deviceName: "TV",
});

/** Virtual clock: `sleep` advances time instead of waiting. */
const setup = (script: Script, complete = vi.fn(async (_approved: unknown): Promise<PairingCompletion> => ({ ok: true }))) => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const states: PairingState[] = [];
  const slept: number[] = [];
  const client: PairingClientCore = {
    start: vi.fn(async () => {
      const next = script.starts.shift();
      if (!next) throw new Error("no more scripted starts");
      if (next instanceof Error) throw next;
      return next;
    }),
    poll: vi.fn(async () => {
      const next = script.polls.shift();
      if (next === undefined) return new Promise<PairingPoll>(() => undefined);
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return next;
    }),
    cancel: vi.fn(),
  };
  const controller = createPairingController({
    client,
    complete,
    onState: (state) => states.push(state),
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  return { controller, client, script, states, slept, complete, settle, now: () => clock, advance: (ms: number) => void (clock += ms) };
};

const phases = (states: PairingState[]) => states.map((s) => s.phase);

describe("TV pairing controller", () => {
  it("shows a code, then completes the sign-in when another app approves it", async () => {
    console.info("[tv-pairing-controller:phase] approve");
    const t = setup({ starts: [], polls: [{ status: "pending" }, APPROVED] });
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    console.info("[tv-pairing-controller:state]", { phases: phases(t.states), slept: t.slept });

    expect(phases(t.states)).toEqual(["starting", "waiting", "completing", "done"]);
    expect(t.complete).toHaveBeenCalledWith(APPROVED);
    const waiting = t.states[1];
    expect(waiting).toMatchObject({ phase: "waiting", renewals: 0, request: { shortCode: "CODE-0001" } });
    // A pending answer that came back at once is not asked again at once (the API did not hold the poll).
    expect(t.slept[0]).toBeGreaterThan(0);
  });

  it("renews the code by itself when the API says it expired", async () => {
    const t = setup({ starts: [], polls: [{ status: "expired" }, { status: "pending" }] });
    t.script.starts.push(created(1, t.now() + 600_000), created(2, t.now() + 1_200_000));
    t.controller.start();
    await t.settle();
    console.info("[tv-pairing-controller:state]", { phases: phases(t.states), slept: t.slept });

    expect(t.client.start).toHaveBeenCalledTimes(2);
    const waiting = t.states.filter((s) => s.phase === "waiting");
    expect(waiting).toHaveLength(2);
    expect(waiting[1]).toMatchObject({ renewals: 1, request: { requestId: "req-2" } });
    // Renewing right away would hammer the API's rate limit.
    expect(t.slept).toContain(MIN_RENEW_GAP_MS);
  });

  it("renews on the local clock when a poll never answers 'expired'", async () => {
    const t = setup({ starts: [], polls: [] });
    t.script.starts.push(created(1, t.now() + 30_000), created(2, t.now() + 3_600_000));
    t.script.polls.push(async () => {
      t.advance(31_000);
      return { status: "pending" };
    });
    t.controller.start();
    await t.settle();
    expect(t.client.start).toHaveBeenCalledTimes(2);
    expect(t.states.filter((s) => s.phase === "waiting")).toHaveLength(2);
  });

  it("stops on a denial and does not ask for a new code", async () => {
    const t = setup({ starts: [], polls: [{ status: "denied" }] });
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    expect(phases(t.states)).toEqual(["starting", "waiting", "denied"]);
    expect(t.client.start).toHaveBeenCalledTimes(1);
    expect(t.complete).not.toHaveBeenCalled();
  });

  it("reports an unreadable key instead of signing in", async () => {
    const t = setup({ starts: [], polls: [{ status: "key_unreadable" }] });
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    expect(t.states.at(-1)).toEqual({ phase: "error", reason: "key_unreadable" });
    expect(t.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["key_mismatch", "key_mismatch"],
    ["failed", "failed"],
  ] as const)("reports a failed completion (%s)", async (reason, expected) => {
    const complete = vi.fn(async (_approved: unknown): Promise<PairingCompletion> => ({ ok: false, reason }));
    const t = setup({ starts: [], polls: [APPROVED] }, complete);
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    expect(t.states.at(-1)).toEqual({ phase: "error", reason: expected });
  });

  // @req ACCT-AUTH-11
  it.each([
    ["a server error", new PairingHttpError(500, "boom"), "failed"],
    ["no network", new TypeError("Network request failed"), "unreachable"],
    ["a web page instead of the API", new PairingHttpError(404, null), "unreachable"],
    ["a 2xx that is not the API's JSON", new PairingHttpError(200, "invalid_response"), "unreachable"],
  ] as const)("explains %s when asking for a code", async (_label, error, expected) => {
    const t = setup({ starts: [error], polls: [] });
    t.controller.start();
    await t.settle();
    console.info("[tv-pairing-controller:state]", { phases: phases(t.states), last: t.states.at(-1) });
    expect(t.states.at(-1)).toEqual({ phase: "error", reason: expected });
  });

  // @req ACCT-AUTH-11
  it.each([
    ["the API's wait, rounded up to whole minutes", new PairingHttpError(429, "rate_limited", 61), 2],
    ["at least one minute", new PairingHttpError(429, "rate_limited", 5), 1],
    ["the default wait when a proxy's 429 does not say", new PairingHttpError(429, null), 15],
  ] as const)("a 429 ends in rate_limited with %s", async (_label, error, minutes) => {
    const t = setup({ starts: [error], polls: [] });
    t.controller.start();
    await t.settle();
    console.info("[pairing-controller:429] state", { last: t.states.at(-1) });
    expect(t.states.at(-1)).toEqual({ phase: "error", reason: "rate_limited", retryAfterMinutes: minutes });
  });

  it("rides out a short network drop but gives up after repeated poll failures", async () => {
    const drop = () => new TypeError("Network request failed");
    const t = setup({ starts: [], polls: [drop(), drop(), { status: "denied" }] });
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    expect(t.states.at(-1)).toEqual({ phase: "denied" });

    const t2 = setup({ starts: [], polls: Array.from({ length: MAX_POLL_FAILURES }, drop) });
    t2.script.starts.push(created(1, t2.now() + 600_000));
    t2.controller.start();
    await t2.settle();
    console.info("[tv-pairing-controller:state]", { phases: phases(t2.states), polls: t2.client.poll });
    expect(t2.states.at(-1)).toEqual({ phase: "error", reason: "unreachable" });
    expect(t2.client.poll).toHaveBeenCalledTimes(MAX_POLL_FAILURES);
  });

  it("cancels the client and emits nothing once the screen is left", async () => {
    const t = setup({ starts: [], polls: [] });
    t.script.starts.push(created(1, t.now() + 600_000));
    t.controller.start();
    await t.settle();
    const before = t.states.length;
    t.controller.stop();
    expect(t.client.cancel).toHaveBeenCalled();
    await t.settle();
    expect(t.states).toHaveLength(before);
  });
});
