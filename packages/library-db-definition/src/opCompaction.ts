import type { LibraryOp } from "@space/shared/libraryOps";

/**
 * The clock a state-replacing op carries, compared as ISO-8601 text. An op
 * without one (hand-built payloads in tests, older streams) sorts first, so
 * among equals the later arrival wins.
 */
const opClock = (op: LibraryOp): string => {
  switch (op.type) {
    case "media.upsert":
      return op.payload.details.updatedAt ?? "";
    case "media.progress":
    case "setting.set":
      return op.payload.updatedAt ?? "";
    default:
      return "";
  }
};

const supersedeKey = (op: LibraryOp): string | null => {
  switch (op.type) {
    case "media.upsert":
      return `upsert:${op.payload.details.id}`;
    case "media.progress":
      return `progress:${op.payload.mediaId}`;
    case "setting.set":
      return `setting:${op.payload.key}`;
    default:
      return null;
  }
};

/**
 * Collapse a batch of ops to what a receiver would end up with. For each
 * media.upsert / media.progress / setting.set key the NEWEST op by its own
 * timestamp survives (LIB-SYNC-08: "latest" is the most recent change, not
 * the last one to arrive; the SQL guards in `ops.ts` ignore an older op, so
 * keeping the last-arrived one would drop the newer change). A tie goes to the
 * later arrival. Deletes and every other op type are preserved in order;
 * upserts and progress for a media deleted later in the batch are dropped.
 */
export const compactLibraryOps = (ops: LibraryOp[]) => {
  const newest = new Map<string, LibraryOp>();
  for (const op of ops) {
    const key = supersedeKey(op);
    if (key === null) continue;
    const incumbent = newest.get(key);
    if (!incumbent || opClock(op) >= opClock(incumbent)) newest.set(key, op);
  }

  const deletedMedia = new Set<string>();
  const filtered: LibraryOp[] = [];

  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    switch (op.type) {
      case "media.delete": {
        const mediaId = op.payload.mediaId;
        if (deletedMedia.has(mediaId)) break;
        deletedMedia.add(mediaId);
        filtered.push(op);
        break;
      }
      case "media.upsert": {
        if (deletedMedia.has(op.payload.details.id) || newest.get(supersedeKey(op)!) !== op) break;
        filtered.push(op);
        break;
      }
      case "media.progress": {
        if (deletedMedia.has(op.payload.mediaId) || newest.get(supersedeKey(op)!) !== op) break;
        filtered.push(op);
        break;
      }
      case "setting.set": {
        if (newest.get(supersedeKey(op)!) !== op) break;
        filtered.push(op);
        break;
      }
      default:
        filtered.push(op);
        break;
    }
  }

  return filtered.reverse();
};
