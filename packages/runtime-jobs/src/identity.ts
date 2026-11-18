export type ParsedRuntimeJobId = { app: "badger"; kind: "ingest"; rawId: string; ownerId: string | null; jobId: string };

export const buildBadgerRuntimeIngestJobId = (ownerId: string | null | undefined, rawId: string) =>
  `badger:ingest:${ownerId && ownerId.trim().length > 0 ? ownerId : "active"}:${rawId}`;

export const parseRuntimeJobId = (jobId: string): ParsedRuntimeJobId | null => {
  const [app, kind, ...rest] = jobId.split(":");
  if (!app || !kind || rest.length < 1) return null;
  if (app === "badger" && kind === "ingest" && rest.length >= 2) {
    return {
      app,
      kind,
      ownerId: rest[0] ?? null,
      rawId: rest.slice(1).join(":"),
      jobId,
    };
  }
  return null;
};
