import { z } from "zod";
import { defineCommand } from "../helpers";

export const badgerMediaDelete = defineCommand({
  name: "badger.media.delete" as const,
  module: "badger",
  payloadSchema: z.object({
    mediaId: z.string().min(1),
  }),
  resultSchema: z.object({
    deletedKeys: z.number().int().min(0),
    reclaimedBytes: z.number().int().min(0),
  }),
});
