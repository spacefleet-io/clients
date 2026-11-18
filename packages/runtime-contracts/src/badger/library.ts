import { z } from "zod";
import { defineCommand } from "../helpers";

const snapshotViewSchema = z.object({
  snapshotId: z.string(),
  version: z.number(),
  stateHash: z.string().nullable(),
  mediaCount: z.number(),
  playlistCount: z.number(),
  updatedAt: z.string(),
  isHead: z.boolean().optional(),
});

export const badgerLibraryGetState = defineCommand({
  name: "badger.library.get_state" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    listedAt: z.string(),
    totalSnapshots: z.number(),
    headSnapshotId: z.string().nullable(),
    head: snapshotViewSchema.nullable(),
  }),
});

export const badgerLibraryUpsertSnapshot = defineCommand({
  name: "badger.library.upsert_snapshot" as const,
  module: "badger",
  payloadSchema: z.object({
    snapshotId: z.string().min(1),
    version: z.number().int().min(0),
    mediaCount: z.number().int().min(0).optional().default(0),
    playlistCount: z.number().int().min(0).optional().default(0),
    stateHash: z.string().nullable().optional(),
    updatedAt: z.string().optional(),
  }),
  resultSchema: z.object({
    snapshotId: z.string(),
    version: z.number(),
    isHead: z.boolean(),
    totalSnapshots: z.number(),
    updatedAt: z.string(),
  }),
});

export const badgerLibraryListSnapshots = defineCommand({
  name: "badger.library.list_snapshots" as const,
  module: "badger",
  payloadSchema: z.object({
    limit: z.number().int().positive().optional(),
  }),
  resultSchema: z.object({
    listedAt: z.string(),
    totalSnapshots: z.number(),
    snapshots: z.array(snapshotViewSchema),
  }),
});

export const badgerLibraryGetSnapshot = defineCommand({
  name: "badger.library.get_snapshot" as const,
  module: "badger",
  payloadSchema: z.object({
    snapshotId: z.string().optional(),
  }),
  resultSchema: snapshotViewSchema,
});

export const badgerLibraryClear = defineCommand({
  name: "badger.library.clear" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    cleared: z.number(),
    clearedAt: z.string(),
  }),
});
