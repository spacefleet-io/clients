import { describe, expect, it } from "vitest";
import type { FetchInit, FetchResponse } from "@space/metadata-client";
import { createLookupPacer } from "@/lib/lookupPacer";

const LOOKUP = "https://metadata.example/lookup";
const ISSUE = "https://api.example/metadata/tickets";
const INIT: FetchInit = { method: "POST", headers: {}, body: "{}" };

const response = (status: number, retryAfter?: string): FetchResponse => ({
  status,
  headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
  json: async () => ({}),
});

/** A fetch whose answers the test releases by hand, recording how many were in flight at once. */
const manualFetch = () => {
  const pending: Array<{ url: string; body: string; answer: (r: FetchResponse) => void }> = [];
  let inFlight = 0;
  let peak = 0;
  const fetch = async (url: string, init: FetchInit) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const { promise, resolve } = Promise.withResolvers<FetchResponse>();
    pending.push({ url, body: init.body, answer: resolve });
    try {
      return await promise;
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, pending, peak: () => peak };
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("createLookupPacer", () => {
  it("keeps at most `concurrency` lookups in flight and starts the next as one ends", async () => {
    const backend = manualFetch();
    const pacer = createLookupPacer(backend.fetch, { concurrency: 2 });
    const calls = Array.from({ length: 5 }, () => pacer(LOOKUP, INIT));
    await settle();
    expect(backend.pending).toHaveLength(2);
    backend.pending[0].answer(response(200));
    await settle();
    expect(backend.pending).toHaveLength(3);
    for (let i = 1; i < 5; i += 1) {
      await settle();
      backend.pending[i]?.answer(response(200));
    }
    const answers = await Promise.all(calls);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(backend.peak()).toBe(2);
  });

  it("gives a freed slot to a waiting foreground lookup before an earlier background artwork copy", async () => {
    const backend = manualFetch();
    const pacer = createLookupPacer(backend.fetch, { concurrency: 1 });
    const image = { ...INIT, body: JSON.stringify({ op: "image", kind: "poster", path: "/a.jpg" }) };
    const details = { ...INIT, body: JSON.stringify({ op: "details", type: "movie", id: 1 }) };
    const calls = [pacer(LOOKUP, image), pacer(LOOKUP, image), pacer(LOOKUP, details)];
    await settle();
    expect(backend.pending).toHaveLength(1);
    backend.pending[0].answer(response(200));
    await settle();
    expect(JSON.parse(backend.pending[1].body)).toMatchObject({ op: "details" });
    backend.pending[1].answer(response(200));
    await settle();
    expect(JSON.parse(backend.pending[2].body)).toMatchObject({ op: "image" });
    backend.pending[2].answer(response(200));
    await Promise.all(calls);
  });

  it("lets other requests (ticket issuance) through untouched", async () => {
    const backend = manualFetch();
    const pacer = createLookupPacer(backend.fetch, { concurrency: 1 });
    void pacer(LOOKUP, INIT);
    void pacer(LOOKUP, INIT);
    const issuance = pacer(ISSUE, INIT);
    await settle();
    // The second lookup waits for the only slot; the issuance does not wait behind it.
    expect(backend.pending.map((p) => p.url).sort()).toEqual([ISSUE, LOOKUP]);
    backend.pending.find((p) => p.url === ISSUE)?.answer(response(200));
    await expect(issuance).resolves.toMatchObject({ status: 200 });
  });

  it("after a 429, holds every lookup until Retry-After has passed, then re-sends the refused one", async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const sent: number[] = [];
    let answered429 = false;
    const pacer = createLookupPacer(
      async () => {
        sent.push(clock);
        if (!answered429) {
          answered429 = true;
          return response(429, "3");
        }
        return response(200);
      },
      {
        concurrency: 1,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      }
    );
    const first = pacer(LOOKUP, INIT);
    const second = pacer(LOOKUP, INIT);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(sleeps).toEqual([3_000]);
    // The 429'd lookup and the one queued behind it both left after the 3 s pause, none before it.
    expect(sent).toEqual([1_000_000, 1_003_000, 1_003_000]);
  });

  it("returns the last 429 to the client after maxAttempts sends", async () => {
    let clock = 0;
    let sends = 0;
    const pacer = createLookupPacer(
      async () => {
        sends += 1;
        return response(429);
      },
      { maxAttempts: 3, now: () => clock, sleep: async (ms) => void (clock += ms) }
    );
    const answer = await pacer(LOOKUP, INIT);
    expect(answer.status).toBe(429);
    expect(sends).toBe(3);
  });
});
