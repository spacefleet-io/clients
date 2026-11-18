import { z } from "zod";
import { defineCommand } from "../helpers";

export const badgerCapabilitiesGetFfmpeg = defineCommand({
  name: "badger.capabilities.get_ffmpeg" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.record(z.string(), z.unknown()),
});

export const badgerCapabilitiesTestFfmpeg = defineCommand({
  name: "badger.capabilities.test_ffmpeg" as const,
  module: "badger",
  payloadSchema: z.object({
    encoder: z.string().optional(),
  }),
  resultSchema: z.record(z.string(), z.unknown()),
});
