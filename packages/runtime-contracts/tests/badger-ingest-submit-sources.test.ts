import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  badgerIngestAttachMetadata,
  badgerIngestConfigureScheduling,
  badgerIngestPlanOutputs,
  badgerIngestSubmitSources,
} from "../src/badger/ingest";

const SUITE = "badger-ingest-submit-sources";

type AnyContract =
  | typeof badgerIngestSubmitSources
  | typeof badgerIngestAttachMetadata
  | typeof badgerIngestPlanOutputs
  | typeof badgerIngestConfigureScheduling;

const summarizeContract = (contract: AnyContract) => ({
  name: contract.name,
  module: contract.module,
});

const summarizeSources = (
  sources: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> =>
  sources.map((s, idx) => ({
    index: idx,
    keys: Object.keys(s),
    filename: s.filename,
    sizeMb: s.sizeMb,
    desiredFormats: s.desiredFormats,
    hints: s.hints,
    audioOverridesCount: Array.isArray(s.audioOverrides)
      ? s.audioOverrides.length
      : undefined,
    subtitleOverridesCount: Array.isArray(s.subtitleOverrides)
      ? s.subtitleOverrides.length
      : undefined,
  }));

const dumpIngestSnapshot = (
  label: string,
  ctx: {
    contract: { name: string; module: string };
    payload?: unknown;
    safeParse?: z.ZodSafeParseResult<unknown>;
    parsed?: unknown;
    note?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(
      `contract envelope:\n${JSON.stringify(ctx.contract, null, 2)}`,
    );
    if (ctx.payload !== undefined) {
      const payloadAny = ctx.payload as { sources?: unknown };
      const sources = Array.isArray(payloadAny?.sources)
        ? (payloadAny.sources as Array<Record<string, unknown>>)
        : undefined;
      console.error(
        `payload shape:\n${JSON.stringify(
          {
            keys:
              ctx.payload && typeof ctx.payload === "object"
                ? Object.keys(ctx.payload as object)
                : undefined,
            sourceCount: sources?.length,
            sources: sources ? summarizeSources(sources) : undefined,
            raw: ctx.payload,
          },
          null,
          2,
        )}`,
      );
    }
    if (ctx.safeParse !== undefined) {
      console.error(
        `validation result:\n${JSON.stringify(
          {
            success: ctx.safeParse.success,
            data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
            issues: ctx.safeParse.success ? null : ctx.safeParse.error.issues,
          },
          null,
          2,
        )}`,
      );
    }
    if (ctx.parsed !== undefined) {
      console.error(`parsed value:\n${JSON.stringify(ctx.parsed, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("badger.ingest.submit_sources", () => {
  console.info(
    `[${SUITE}:setup] contract=${badgerIngestSubmitSources.name} module=${badgerIngestSubmitSources.module}`,
  );

  it("accepts a single source with default formats", () => {
    const payload = {
      userId: "user_1",
      sources: [{ filename: "Orchard.2017.mkv", sizeMb: 4200 }],
    };
    const resultInput = {
      submitted: [
        {
          groupId: "media_coco",
          sourceJobId: "job_src_1",
          placementId: "job_src_1_placement",
          formatJobIds: [{ variant: "360p", jobId: "job_fmt_1" }],
        },
      ],
    };
    try {
      const parsed = badgerIngestSubmitSources.payloadSchema.parse(payload);
      expect(parsed.sources).toHaveLength(1);
      expect(parsed.sources[0]?.desiredFormats).toEqual([]);
      expect(parsed.sources[0]?.filename).toBe("Orchard.2017.mkv");

      const result = badgerIngestSubmitSources.resultSchema.parse(resultInput);
      expect(result.submitted[0]?.formatJobIds).toHaveLength(1);
    } catch (err) {
      dumpIngestSnapshot("single-source-default-formats-failed", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: badgerIngestSubmitSources.payloadSchema.safeParse(payload),
        extra: {
          resultInput,
          resultSafeParse:
            badgerIngestSubmitSources.resultSchema.safeParse(resultInput),
        },
        note: "Default desiredFormats should be [] (the 360p fallback copy is a per-computer choice made by the desktop app)",
      });
      throw err;
    }
  });

  it("accepts multi-source with multiple formats each", () => {
    const payload = {
      userId: "user_1",
      sources: [
        {
          filename: "Show.S01E01.mkv",
          sizeMb: 1500,
          sourceQuality: "1080p",
          desiredFormats: ["1080p", "720p", "360p"],
          hints: { season: 1, episode: 1, matchedTitle: "Show" },
        },
        {
          filename: "Show.S01E02.mkv",
          sizeMb: null,
          desiredFormats: ["720p", "360p"],
          hints: { season: 1, episode: 2 },
        },
      ],
    };
    try {
      const parsed = badgerIngestSubmitSources.payloadSchema.parse(payload);
      expect(parsed.sources).toHaveLength(2);
      expect(parsed.sources[0]?.desiredFormats).toEqual(["1080p", "720p", "360p"]);
      expect(parsed.sources[1]?.hints?.episode).toBe(2);
    } catch (err) {
      dumpIngestSnapshot("multi-source-multi-format-failed", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: badgerIngestSubmitSources.payloadSchema.safeParse(payload),
      });
      throw err;
    }
  });

  it("rejects an empty sources array", () => {
    const payload = { userId: "user_1", sources: [] };
    const result = badgerIngestSubmitSources.payloadSchema.safeParse(payload);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("empty-sources-accepted", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: result,
        note: "sources should be a non-empty array",
      });
      throw err;
    }
  });

  it("rejects an unknown quality variant", () => {
    const payload = {
      userId: "user_1",
      sources: [{ filename: "movie.mkv", desiredFormats: ["8k"] }],
    };
    const result = badgerIngestSubmitSources.payloadSchema.safeParse(payload);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("unknown-quality-variant-accepted", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: result,
        note: "desiredFormats must be from the known quality enum",
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof Bug #4 — accepts audioOverrides and subtitleOverrides on a source item", () => {
    const payload = {
      userId: "user_1",
      sources: [
        {
          filename: "Orchard.2017.mkv",
          sizeMb: 4200,
          audioOverrides: [
            { index: 0, language: "en", label: "English" },
            { index: 1, language: "fr", label: "French (5.1)" },
          ],
          subtitleOverrides: [{ index: 0, language: "en", label: "English" }],
        },
      ],
    };
    try {
      const parsed = badgerIngestSubmitSources.payloadSchema.parse(payload);
      expect(parsed.sources[0]?.audioOverrides).toEqual([
        { index: 0, language: "en", label: "English" },
        { index: 1, language: "fr", label: "French (5.1)" },
      ]);
      expect(parsed.sources[0]?.subtitleOverrides).toEqual([
        { index: 0, language: "en", label: "English" },
      ]);
    } catch (err) {
      dumpIngestSnapshot("bugfix-overrides-rejected", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: badgerIngestSubmitSources.payloadSchema.safeParse(payload),
        note: "Bug #4 regression — audioOverrides/subtitleOverrides accepted on each source",
      });
      throw err;
    }
  });

  it("treats audioOverrides / subtitleOverrides as optional (Bug #4 backwards-compat)", () => {
    const payload = { userId: "user_1", sources: [{ filename: "movie.mkv" }] };
    try {
      const parsed = badgerIngestSubmitSources.payloadSchema.parse(payload);
      expect(parsed.sources[0]?.audioOverrides).toBeUndefined();
      expect(parsed.sources[0]?.subtitleOverrides).toBeUndefined();
    } catch (err) {
      dumpIngestSnapshot("backcompat-overrides-not-optional", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: badgerIngestSubmitSources.payloadSchema.safeParse(payload),
      });
      throw err;
    }
  });

  it("rejects audio override with negative index", () => {
    const payload = {
      userId: "user_1",
      sources: [
        {
          filename: "movie.mkv",
          audioOverrides: [{ index: -1, language: "en", label: "English" }],
        },
      ],
    };
    const result = badgerIngestSubmitSources.payloadSchema.safeParse(payload);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("negative-audio-index-accepted", {
        contract: summarizeContract(badgerIngestSubmitSources),
        payload,
        safeParse: result,
        note: "audioOverrides[].index must be a non-negative integer",
      });
      throw err;
    }
  });
});

describe("badger.ingest.attach_metadata", () => {
  it("round-trips a valid attach_metadata payload and result", () => {
    const payloadInput = {
      jobId: "job_src_1",
      mediaId: "media_coco",
      season: 1,
      episode: 3,
    };
    const resultInput = { attached: true, jobId: "job_src_1" };
    try {
      const payload =
        badgerIngestAttachMetadata.payloadSchema.parse(payloadInput);
      expect(payload.jobId).toBe("job_src_1");
      expect(payload.mediaId).toBe("media_coco");

      const result = badgerIngestAttachMetadata.resultSchema.parse(resultInput);
      expect(result.attached).toBe(true);
      expect(result.jobId).toBe("job_src_1");
    } catch (err) {
      dumpIngestSnapshot("attach-metadata-round-trip-failed", {
        contract: summarizeContract(badgerIngestAttachMetadata),
        payload: payloadInput,
        safeParse:
          badgerIngestAttachMetadata.payloadSchema.safeParse(payloadInput),
        extra: {
          resultInput,
          resultSafeParse:
            badgerIngestAttachMetadata.resultSchema.safeParse(resultInput),
        },
      });
      throw err;
    }
  });
});

describe("badger.ingest.plan_outputs", () => {
  it("round-trips with formats added and removed", () => {
    const payloadInput = {
      sourceJobId: "job_src_1",
      formats: ["720p", "360p"],
    };
    const resultInput = {
      addedJobIds: [
        { variant: "720p", jobId: "job_fmt_720" },
        { variant: "360p", jobId: "job_fmt_360" },
      ],
      removedJobIds: ["job_fmt_old_480"],
    };
    try {
      const payload =
        badgerIngestPlanOutputs.payloadSchema.parse(payloadInput);
      expect(payload.formats).toEqual(["720p", "360p"]);

      const result = badgerIngestPlanOutputs.resultSchema.parse(resultInput);
      expect(result.addedJobIds).toHaveLength(2);
      expect(result.removedJobIds).toEqual(["job_fmt_old_480"]);
    } catch (err) {
      dumpIngestSnapshot("plan-outputs-round-trip-failed", {
        contract: summarizeContract(badgerIngestPlanOutputs),
        payload: payloadInput,
        safeParse:
          badgerIngestPlanOutputs.payloadSchema.safeParse(payloadInput),
        extra: {
          resultInput,
          resultSafeParse:
            badgerIngestPlanOutputs.resultSchema.safeParse(resultInput),
        },
      });
      throw err;
    }
  });
});

describe("badger.ingest.configure_scheduling", () => {
  it("has the expected command name and module", () => {
    try {
      expect(badgerIngestConfigureScheduling.name).toBe(
        "badger.ingest.configure_scheduling",
      );
      expect(badgerIngestConfigureScheduling.module).toBe("badger");
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-name-drift", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
      });
      throw err;
    }
  });

  it("round-trips a valid payload and an applied result with caps", () => {
    const payloadInput = {
      maxParallelTranscodes: 2,
      maxParallelExtractions: 3,
    };
    const resultInput = { applied: true, caps: { format: 2, source: 3 } };
    try {
      const payload =
        badgerIngestConfigureScheduling.payloadSchema.parse(payloadInput);
      expect(payload.maxParallelTranscodes).toBe(2);
      expect(payload.maxParallelExtractions).toBe(3);

      const result =
        badgerIngestConfigureScheduling.resultSchema.parse(resultInput);
      expect(result.applied).toBe(true);
      expect(result.caps).toEqual({ format: 2, source: 3 });
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-round-trip-failed", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
        payload: payloadInput,
        safeParse:
          badgerIngestConfigureScheduling.payloadSchema.safeParse(payloadInput),
        extra: {
          resultInput,
          resultSafeParse:
            badgerIngestConfigureScheduling.resultSchema.safeParse(resultInput),
        },
      });
      throw err;
    }
  });

  it("accepts an applied:false result with caps omitted (engine unavailable)", () => {
    const resultInput = { applied: false };
    try {
      const result =
        badgerIngestConfigureScheduling.resultSchema.parse(resultInput);
      expect(result.applied).toBe(false);
      expect(result.caps).toBeUndefined();
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-applied-false-rejected", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
        safeParse:
          badgerIngestConfigureScheduling.resultSchema.safeParse(resultInput),
        extra: { resultInput },
        note: "applied:false with caps omitted should be valid (engine unavailable case)",
      });
      throw err;
    }
  });

  it("rejects payload values outside the 1..3 range", () => {
    const lowPayload = {
      maxParallelTranscodes: 0,
      maxParallelExtractions: 1,
    };
    const highPayload = {
      maxParallelTranscodes: 1,
      maxParallelExtractions: 4,
    };
    const lowResult =
      badgerIngestConfigureScheduling.payloadSchema.safeParse(lowPayload);
    const highResult =
      badgerIngestConfigureScheduling.payloadSchema.safeParse(highPayload);
    try {
      expect(lowResult.success).toBe(false);
      expect(highResult.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-range-rejection-failed", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
        extra: {
          lowPayload,
          lowResult,
          highPayload,
          highResult,
        },
        note: "maxParallel* must be in 1..3",
      });
      throw err;
    }
  });

  it("rejects a non-integer payload value", () => {
    const payload = {
      maxParallelTranscodes: 1.5,
      maxParallelExtractions: 2,
    };
    const result =
      badgerIngestConfigureScheduling.payloadSchema.safeParse(payload);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-non-integer-accepted", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
        payload,
        safeParse: result,
        note: "maxParallelTranscodes must be an integer",
      });
      throw err;
    }
  });

  it("rejects a payload missing a required field", () => {
    const payload = { maxParallelTranscodes: 2 };
    const result =
      badgerIngestConfigureScheduling.payloadSchema.safeParse(payload);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpIngestSnapshot("configure-scheduling-missing-field-accepted", {
        contract: summarizeContract(badgerIngestConfigureScheduling),
        payload,
        safeParse: result,
        note: "maxParallelExtractions is required",
      });
      throw err;
    }
  });
});
