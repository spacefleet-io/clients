/**
 * @test-id LIB-TRANSIENT-RETRY-001
 * @level unit
 * @why STOR-BW-14: a library chunk download that drops or times out is tried again, a refusal is not.
 */
import { describe, expect, it } from "bun:test";
import { retryTransient } from "../src/transientRetry";

const failing = (errors: unknown[]) => {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      const next = errors[calls];
      calls += 1;
      if (next !== undefined) throw next;
      return "ok";
    },
  };
};

describe("retryTransient @req STOR-BW-14", () => {
  it("retries a timeout and a 5xx, then succeeds", async () => {
    const op = failing([new Error("TUNNEL_DOWNLOAD_TIMEOUT"), Object.assign(new Error("bad gateway"), { status: 502 })]);
    const retries: number[] = [];
    expect(await retryTransient(op.run, (attempt) => retries.push(attempt), 1)).toBe("ok");
    console.info("[transient-retry] calls", op.calls(), "retries", retries);
    expect(op.calls()).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("gives up after three attempts with the last error", async () => {
    const op = failing([new Error("a"), new Error("b"), new Error("c"), new Error("d")]);
    await expect(retryTransient(op.run, undefined, 1)).rejects.toThrow("c");
    expect(op.calls()).toBe(3);
  });

  it("does not retry a refusal, a missing object or a gateway download error", async () => {
    for (const error of [Object.assign(new Error("forbidden"), { status: 403 }), new Error("TUNNEL_DOWNLOAD_ERROR_not_found")]) {
      const op = failing([error]);
      await expect(retryTransient(op.run, undefined, 1)).rejects.toBe(error);
      expect(op.calls()).toBe(1);
    }
  });

  it("retries a 429", async () => {
    const op = failing([Object.assign(new Error("slow down"), { status: 429 })]);
    expect(await retryTransient(op.run, undefined, 1)).toBe("ok");
    expect(op.calls()).toBe(2);
  });
});
