/**
 * @test-id MOBILE-WITH-NETWORK-TIMEOUT-001
 * @level unit
 *
 * `withNetworkTimeout` bounds the library preflight requests (the API client has no timeout). Its rejection
 * must read as a network outage so the library store routes it to the offline path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { withNetworkTimeout } from "../src/lib/withNetworkTimeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withNetworkTimeout", () => {
  it("passes the value through when the promise settles in time, leaving no timer behind", async () => {
    vi.useFakeTimers();
    await expect(withNetworkTimeout(Promise.resolve("ok"), 1000, "thing")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the rejection through when the promise fails in time, leaving no timer behind", async () => {
    vi.useFakeTimers();
    await expect(withNetworkTimeout(Promise.reject(new Error("boom")), 1000, "thing")).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a network-failure message when the promise never settles", async () => {
    vi.useFakeTimers();
    const pending = withNetworkTimeout(new Promise<string>(() => undefined), 1000, "library meta");
    const outcome = expect(pending).rejects.toThrow("Network request failed: library meta timed out after 1000 ms");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });
});
