import { z } from "zod";
import { defineCommand } from "../helpers";

/**
 * `userId`: the signed-in account. The runtime keeps each account's library in its own dir per API server
 * (LIB-STORE-06) and never opens another account's; absent, it uses the user of the last `/runtime/keys/set`.
 */
export const badgerDbOpen = defineCommand({
  name: "badger.db.open" as const,
  module: "badger",
  payloadSchema: z.object({
    token: z.string().min(1),
    keyBase64: z.string().min(1),
    userId: z.string().min(1).optional(),
  }),
  resultSchema: z.record(z.string(), z.unknown()),
});

/**
 * Local-only open: opens the on-disk library DB (per-group SQLite + cache)
 * WITHOUT any remote pull, and leaves sync disabled. This is the runtime-proxy
 * equivalent of `LibraryDb.openLocal` — used for offline mode when the backend
 * is unreachable. Payload mirrors `badger.db.open` so the desktop proxy can
 * forward the same token/key/userId it already holds.
 */
export const badgerDbOpenLocal = defineCommand({
  name: "badger.db.open_local" as const,
  module: "badger",
  payloadSchema: z.object({
    token: z.string().min(1),
    keyBase64: z.string().min(1),
    userId: z.string().min(1).optional(),
  }),
  resultSchema: z.record(z.string(), z.unknown()),
});

export const badgerDbClose = defineCommand({
  name: "badger.db.close" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    closed: z.literal(true),
  }),
});

/**
 * The library snapshot. With `mediaIds` it is a delta snapshot (#671 R3): every
 * list is complete but `mediaDetails` holds only those media, so a caller that
 * already has the previous snapshot can merge it without the runtime reading
 * every media's details. The result carries the `version` it is at.
 */
export const badgerDbSnapshot = defineCommand({
  name: "badger.db.snapshot" as const,
  module: "badger",
  payloadSchema: z.object({
    mediaIds: z.array(z.string()).optional(),
  }),
  resultSchema: z.record(z.string(), z.unknown()),
});

export const badgerDbCall = defineCommand({
  name: "badger.db.call" as const,
  module: "badger",
  payloadSchema: z.object({
    method: z.string().min(1),
    args: z.array(z.unknown()).optional().default([]),
    /**
     * #25: the caller does not need this write's `library.updated` frame now
     * (playback progress saved while the app window is hidden behind external
     * mpv). The runtime still persists the write immediately but coalesces the
     * snapshot publish; any later immediate publish carries it sooner. Absent =
     * publish as soon as the call moves the library version.
     */
    deferPublish: z.boolean().optional(),
  }),
  resultSchema: z.unknown(),
});

/** Sign-out: removes the account's library files (LIB-STORE-06); `userId` absent = the account last opened. */
export const badgerDbClearLocalCache = defineCommand({
  name: "badger.db.clearLocalCache" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().min(1).optional(),
  }),
  resultSchema: z.object({
    cleared: z.literal(true),
  }),
});

export const badgerDbStatus = defineCommand({
  name: "badger.db.status" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    open: z.boolean(),
    version: z.unknown(),
    datasetStatus: z.unknown(),
  }),
});
