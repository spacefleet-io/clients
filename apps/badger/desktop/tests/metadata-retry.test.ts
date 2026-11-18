import { describe, expect, it, vi } from "vitest";
import { MetadataRequestError, MetadataUnavailableError, NoTicketError } from "@space/metadata-client";
import { withMetadataRetry } from "@/lib/metadataRetry";

describe("withMetadataRetry", () => {
  it("waits out the service's Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MetadataUnavailableError(429, 7, "rate_limited"))
      .mockRejectedValueOnce(new MetadataUnavailableError(503, undefined, "upstream_capacity"))
      .mockResolvedValue("details");
    await expect(withMetadataRetry(run, { sleep })).resolves.toBe("details");
    expect(run).toHaveBeenCalledTimes(3);
    // Retry-After (7 s) beats the 1 s backoff; with none, the backoff doubles (2 s).
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7_000, 2_000]);
  });

  it("caps a long Retry-After at 30 s", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MetadataUnavailableError(429, 600))
      .mockResolvedValue("ok");
    await withMetadataRetry(run, { sleep });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("retries a 5xx and a dropped connection with the backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MetadataRequestError(500))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("details");
    await expect(withMetadataRetry(run, { sleep })).resolves.toBe("details");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it("throws a 4xx answer at once", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const notFound = new MetadataRequestError(404);
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(notFound);
    await expect(withMetadataRetry(run, { sleep })).rejects.toBe(notFound);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws any other error at once", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const noTicket = new NoTicketError();
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(noTicket);
    await expect(withMetadataRetry(run, { sleep })).rejects.toBe(noTicket);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt with the service's error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(new MetadataUnavailableError(429, 1));
    await expect(withMetadataRetry(run, { attempts: 3, sleep })).rejects.toBeInstanceOf(MetadataUnavailableError);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
