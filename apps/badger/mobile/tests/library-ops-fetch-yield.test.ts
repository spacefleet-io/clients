/**
 * @test-id MOBILE-OPS-FETCH-YIELD-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: catching up 2593 ops after a cold start decrypted every inline payload in one JS task: the
 * decrypt (react-native-quick-crypto, JSI) is synchronous, so `await decrypt()` only queued microtasks and the
 * loop never reached the event loop. The JS thread froze for 1.37 s on a OnePlus 6 (taps dropped, sheet frozen).
 * The loop now yields a macrotask whenever a slice has used its time budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryOpEntry } from "@space/shared/contracts/library";
import { fetchOpPayloads, OP_FETCH_SLICE_BUDGET_MS as SLICE_BUDGET_MS } from "@space/mobile-shell/libraryOps";

const OP_COST_MS = 5;
const OP_COUNT = 120;

const entries = Array.from(
  { length: OP_COUNT },
  (_, index): LibraryOpEntry => ({
    opId: `op-${index}`,
    version: index + 1,
    createdAt: "2026-10-15T00:00:00.000Z",
    size: 4,
    objectKey: `ops/${index}`,
    payloadCiphertext: Buffer.from([1, 2, 3, 4]).toString("base64"),
  })
);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchOpPayloads event-loop yielding", () => {
  it("@bugfix @regression-proof never runs longer than its slice budget without yielding a macrotask", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const decryptCalls: Array<{ at: number; yields: number }> = [];
    let counter = 0;

    const result = fetchOpPayloads(entries, {
      download: async () => {
        throw new Error("inline payloads must not hit the tunnel");
      },
      // Synchronous work under an async signature, like quick-crypto: the fake clock advances OP_COST_MS per op.
      decrypt: async (bytes) => {
        vi.setSystemTime(Date.now() + OP_COST_MS);
        decryptCalls.push({ at: Date.now(), yields: timeouts.mock.calls.length });
        return bytes;
      },
      decode: () => JSON.stringify({ type: "noop", id: `op-${counter++}` }),
    });
    await vi.runAllTimersAsync();
    const ops = await result;

    expect(ops).toHaveLength(OP_COUNT);
    expect(ops.map((op) => (op as { id: string }).id)).toEqual(entries.map((_, index) => `op-${index}`));

    const spans = new Map<number, { first: number; last: number }>();
    for (const call of decryptCalls) {
      const span = spans.get(call.yields) ?? { first: call.at, last: call.at };
      span.last = call.at;
      spans.set(call.yields, span);
    }
    const longestRunMs = Math.max(...[...spans.values()].map((span) => span.last - span.first));
    console.info(
      "[ops-fetch-yield]",
      JSON.stringify({ ops: OP_COUNT, yields: spans.size - 1, longestRunMs, budgetMs: SLICE_BUDGET_MS })
    );
    expect(spans.size, "the loop must yield repeatedly, not once").toBeGreaterThan(10);
    // A slice may overshoot its budget by at most one batch of ops (4 concurrent x OP_COST_MS).
    expect(longestRunMs).toBeLessThanOrEqual(SLICE_BUDGET_MS + 4 * OP_COST_MS);
  });
});
