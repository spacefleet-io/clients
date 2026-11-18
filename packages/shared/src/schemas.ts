import { z } from "zod";

export const libraryMetaSchema = z.object({
  exists: z.boolean(),
  bootstrapRequired: z.boolean().optional(),
  syncUnavailable: z.boolean().optional(),
  version: z.number(),
  snapshotVersion: z.number().optional(),
  stateHash: z.string().nullable().optional(),
  lastOpId: z.string().nullable().optional(),
  consistency: z.enum(["ok", "missing_snapshot"]).optional(),
  keyProbe: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export type LibraryMeta = z.infer<typeof libraryMetaSchema>;

export const storageUploadUrlSchema = z.object({
  key: z.string(),
  url: z.string(),
});

export const storageUploadUrlsResponseSchema = z.object({
  urls: z.array(storageUploadUrlSchema),
});

export type StorageUploadUrlsResponse = z.infer<typeof storageUploadUrlsResponseSchema>;

export const storageDownloadUrlsResponseSchema = z.object({
  urls: z.record(z.string(), z.string()),
});

export type StorageDownloadUrlsResponse = z.infer<typeof storageDownloadUrlsResponseSchema>;

export const storageObjectsResponseSchema = z.object({
  keys: z.array(z.string()),
});

export type StorageObjectsResponse = z.infer<typeof storageObjectsResponseSchema>;
