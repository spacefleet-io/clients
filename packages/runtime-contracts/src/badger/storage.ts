import { z } from "zod";
import { defineCommand } from "../helpers";

export const badgerStorageGc = defineCommand({
  name: "badger.storage.gc" as const,
  module: "badger",
  payloadSchema: z.object({
    dryRun: z.boolean().optional(),
  }),
  resultSchema: z.object({
    orphanedKeys: z.number(),
    deletedKeys: z.number(),
    reclaimedBytes: z.number(),
    failedKeys: z.number(),
    missingKeys: z.number(),
  }),
});
