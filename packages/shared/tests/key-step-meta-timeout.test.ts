/**
 * @test-id SHARED-KEY-STEP-META-TIMEOUT-001
 * @level unit
 * @bugfix @regression-proof
 * @req UX-KEY-02
 *
 * @why The Badger desktop 0.1.72 release smoke hung on "Loading key…" on 2026-11-26 (~02:34Z): a database IO stall on
 *   the server made `GET /library/db/meta` take 39–61 s, and the key step's read had no bound, so the screen waited
 *   with no error and no way out. The read now gives up after KEY_STEP_META_TIMEOUT_MS, retries included, with
 *   `ApiError(0, { error: "timeout" })`; the app shows its Retry screen, and Retry reads again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getLibraryMetaForKeyStep, setApiBaseUrl } from "../src/api";
import {
  KEY_STEP_META_LOG_EVENT,
  KEY_STEP_META_TIMEOUT_MS,
  keyStepLoadFailedText,
  keyStepMetaErrorClass,
  keyStepMetaReadLine,
  type KeyStepMetaRead,
} from "../src/keyStepMetaRead";

const SUITE = "key-step-meta-timeout";
const META = { exists: true, keyProbe: "probe", version: 3 };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
let reads: KeyStepMetaRead[] = [];
const onRead = (read: KeyStepMetaRead) => {
  console.info(`[${SUITE}] ${keyStepMetaReadLine(read)}`);
  reads.push(read);
};

/** Tracks the read without awaiting it, so the test can look before and after the bound. */
const track = (promise: Promise<unknown>) => {
  const state: { settled: boolean; value: unknown; error: unknown } = { settled: false, value: null, error: null };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error })
  );
  return state;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  setApiBaseUrl("https://api.example.test");
  fetchMock.mockReset();
  reads = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe(`[${SUITE}] the key step's meta read is bounded @req UX-KEY-02`, () => {
  it("gives up on a server that never answers at the bound, then a Retry that is answered gets the meta", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const first = track(getLibraryMetaForKeyStep("token", "badger", { onRead }));

    await vi.advanceTimersByTimeAsync(KEY_STEP_META_TIMEOUT_MS - 1);
    console.info(`[${SUITE}:stall] settled before the bound=${first.settled}`);
    expect(first.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    console.info(`[${SUITE}:stall] settled at the bound=${first.settled} error=${String(first.error)}`);
    expect(first.settled).toBe(true);
    expect(first.error).toBeInstanceOf(ApiError);
    expect((first.error as ApiError).status).toBe(0);
    expect(keyStepMetaErrorClass(first.error)).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([
      expect.objectContaining({ step: "library_meta", outcome: "failed", attempts: 1, errorClass: "timeout", status: 0 }),
    ]);
    expect(reads[0]!.durationMs).toBeGreaterThanOrEqual(KEY_STEP_META_TIMEOUT_MS);

    // Retry: the server answers again.
    fetchMock.mockImplementation(async () => json(200, META));
    const retry = track(getLibraryMetaForKeyStep("token", "badger", { onRead }));
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[${SUITE}:retry] settled=${retry.settled} value=${JSON.stringify(retry.value)}`);
    expect(retry.value).toMatchObject(META);
    expect(reads[1]).toMatchObject({ outcome: "ok", attempts: 1, errorClass: null, status: null });
  });

  it("stops waiting out 503s at the bound instead of after every delay", async () => {
    fetchMock.mockImplementation(async () => json(503, { error: "storage_gateway_unavailable" }));
    const read = track(getLibraryMetaForKeyStep("token", "badger", { delaysMs: [5_000, 10_000, 10_000], onRead }));
    await vi.advanceTimersByTimeAsync(KEY_STEP_META_TIMEOUT_MS + 1);
    console.info(`[${SUITE}:503] calls=${fetchMock.mock.calls.length} settled=${read.settled}`);
    expect(read.settled).toBe(true);
    // 0 s, 5 s, 15 s; the 10 s wait after the third would end past 20 s, so the read fails then with the 503.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((read.error as ApiError).status).toBe(503);
    expect(reads).toEqual([expect.objectContaining({ outcome: "failed", attempts: 3, errorClass: "server", status: 503 })]);
  });

  it("logs anonymous fields only", () => {
    const line = keyStepMetaReadLine({ step: "library_meta", outcome: "failed", durationMs: 20_000, attempts: 1, errorClass: "timeout", status: 0 });
    console.info(`[${SUITE}:log] ${line}`);
    expect(line).toBe(`${KEY_STEP_META_LOG_EVENT} step=library_meta outcome=failed durationMs=20000 attempts=1 errorClass=timeout status=0`);
  });

  it("says why in every language, with a Retry", () => {
    for (const language of ["en", "fr", "nl", "de", "es"] as const) {
      const text = keyStepLoadFailedText(language, "timeout");
      console.info(`[${SUITE}:text] ${language} ${text.title} | ${text.body} | ${text.retry}`);
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.retry.length).toBeGreaterThan(0);
      expect(text.body).not.toBe(keyStepLoadFailedText(language, "unreachable").body);
    }
  });
});
