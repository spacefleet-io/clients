import { z } from "zod";
import { defineCommand } from "../helpers";

const dummyIngestJobSchema = z.object({
  id: z.string(),
  userId: z.string(),
  catalogId: z.number(),
  mediaType: z.string(),
  status: z.string(),
  progress: z.number(),
  stage: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const badgerDummyIngestStart = defineCommand({
  name: "badger.dummy_ingest.start" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().min(1),
    jobId: z.string().optional(),
    catalogId: z.number().int().positive(),
    mediaType: z.enum(["movie", "tv"]),
  }),
  resultSchema: z.object({
    jobId: z.string(),
    userId: z.string(),
    status: z.string(),
    progress: z.number(),
  }),
});

export const badgerDummyIngestUpsertJob = defineCommand({
  name: "badger.dummy_ingest.upsert_job" as const,
  module: "badger",
  payloadSchema: z.object({
    jobId: z.string().min(1),
    userId: z.string().optional(),
    catalogId: z.number().optional(),
    mediaType: z.enum(["movie", "tv"]).optional(),
    status: z.enum(["queued", "running", "done", "error"]).optional(),
    progress: z.number().optional(),
    stage: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  resultSchema: dummyIngestJobSchema,
});

export const badgerDummyIngestGetJob = defineCommand({
  name: "badger.dummy_ingest.get_job" as const,
  module: "badger",
  payloadSchema: z.object({
    jobId: z.string().min(1),
  }),
  resultSchema: dummyIngestJobSchema.nullable(),
});

export const badgerDummyIngestListJobs = defineCommand({
  name: "badger.dummy_ingest.list_jobs" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().optional(),
    status: z.string().optional(),
  }),
  resultSchema: z.object({
    userId: z.string().nullable(),
    total: z.number(),
    listedAt: z.string(),
    jobs: z.array(dummyIngestJobSchema),
  }),
});
