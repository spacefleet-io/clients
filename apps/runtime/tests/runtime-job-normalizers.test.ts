import { beforeAll, describe, expect, it } from "vitest";
import { normalizeBadgerJobLike, readResponseResult } from "../src/core/jobs/normalizers";
import type { RuntimeCommandResponse } from "../src/types";

describe("runtime job normalizers [runtime-job-normalizers]", () => {
  beforeAll(() => {
    console.info(`[runtime-job-normalizers:suite-init] exercising readResponseResult + normalizeBadgerJobLike`);
  });

  it("reads ok command results and drops error responses deterministically @bugfix @regression-proof", () => {
    console.info(`[runtime-job-normalizers:read-response-result] ok→result, error→null`);
    const okResponse: RuntimeCommandResponse = {
      requestId: "req-ok",
      ok: true,
      result: { uploadId: "task-1" },
      error: null,
    };
    const failedResponse: RuntimeCommandResponse = {
      requestId: "req-failed",
      ok: false,
      result: null,
      error: {
        code: "invalid_command",
        message: "bad",
        retryable: false,
        details: {},
      },
    };

    expect(readResponseResult(okResponse)).toEqual({ uploadId: "task-1" });
    expect(readResponseResult(failedResponse)).toBeNull();
  });

  it("normalizes badger job-like payload items deterministically @bugfix @regression-proof", () => {
    console.info(`[runtime-job-normalizers:badger-job-like] id=job-1 with progress, no-filename→null`);
    expect(
      normalizeBadgerJobLike({
        id: "job-1",
        filename: "/tmp/movie.mkv",
        status: "uploading",
        progress: 25,
      })
    ).toEqual({
      id: "job-1",
      filename: "/tmp/movie.mkv",
      status: "uploading",
      progress: 25,
    });
    expect(normalizeBadgerJobLike({ id: "job-1", status: "uploading" })).toBeNull();
  });
});
