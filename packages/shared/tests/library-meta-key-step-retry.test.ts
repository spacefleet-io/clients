/**
 * @test-id SHARED-LIBRARY-META-KEY-STEP-RETRY-001
 * @level unit
 * @bugfix @regression-proof
 * @req STOR-GATEWAY-01
 *
 * @why The Badger desktop v0.1.22 release smoke failed at the library key step on 2026-11-20: its one meta read got a
 *   503 while a storage gateway copy was being replaced (21:45:15Z), and the step showed "could not validate the key".
 *   The key step of every app reads meta through `getLibraryMetaForKeyStep`, which tries a 502/503 or a request with no
 *   answer again after 1, 2 and 4 s, and gives up at once on anything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getLibraryMetaForKeyStep, KEY_STEP_META_RETRY_DELAYS_MS, setApiBaseUrl } from "../src/api";

const SUITE = "library-meta-key-step-retry";
const META = { exists: true, keyProbe: "probe", version: 3 };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
let calledAt: number[] = [];

/** Answers the meta reads in order; the last answer repeats. */
const answer = (...steps: Array<number | "network">) => {
  let index = 0;
  fetchMock.mockImplementation(async () => {
    calledAt.push(Date.now());
    const step = steps[Math.min(index++, steps.length - 1)];
    if (step === "network") throw new TypeError("Failed to fetch");
    return step === 200 ? json(200, META) : json(step!, { error: step === 401 ? "unauthorized" : "storage_gateway_unavailable" });
  });
};

const settle = async (promise: Promise<unknown>) => {
  const outcome = promise.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error })
  );
  await vi.runAllTimersAsync();
  return outcome;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  setApiBaseUrl("https://api.example.test");
  calledAt = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const gaps = () => calledAt.slice(1).map((at, index) => at - calledAt[index]!);

describe(`[${SUITE}] the key step's meta read @req STOR-GATEWAY-01`, () => {
  it("waits 1, 2 then 4 s while the server answers 503 or 502 or nothing, then gets the meta", async () => {
    answer(503, 502, "network", 200);
    const outcome = await settle(getLibraryMetaForKeyStep("token"));
    console.info(`[${SUITE}:recovers] calls=${calledAt.length} gaps=${JSON.stringify(gaps())} value=${JSON.stringify(outcome.value)}`);

    expect(outcome.error).toBeNull();
    expect(outcome.value).toMatchObject(META);
    expect(gaps()).toEqual([...KEY_STEP_META_RETRY_DELAYS_MS]);
  });

  it("gives up after the last wait with the server's own error", async () => {
    answer(503);
    const outcome = await settle(getLibraryMetaForKeyStep("token"));
    console.info(`[${SUITE}:gives-up] calls=${calledAt.length} error=${String(outcome.error)}`);

    expect(fetchMock).toHaveBeenCalledTimes(KEY_STEP_META_RETRY_DELAYS_MS.length + 1);
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect((outcome.error as ApiError).status).toBe(503);
  });

  it.each([401, 403, 404, 500])("answers a %i at once, without trying again", async (status) => {
    answer(status);
    const outcome = await settle(getLibraryMetaForKeyStep("token"));
    console.info(`[${SUITE}:final-${status}] calls=${calledAt.length}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((outcome.error as ApiError).status).toBe(status);
  });
});
