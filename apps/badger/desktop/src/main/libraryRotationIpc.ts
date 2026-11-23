import type { IpcMain } from "electron";
import {
  LIBRARY_NOT_SNAPSHOTTED,
  reencryptLibrariesForRotation,
  type RotationLibraryCopy,
} from "@space/library-db-runtime/snapshotTransport";
import { scopeLogger } from "./logger";

const logger = scopeLogger("library-rotation");

/** Every library the account key opens besides Badger's own (PRIV-KEY-06). */
const OTHER_LIBRARY_APPS = ["parrot"] as const;

export type RotationReencryptPayload = { token: string; oldKeyBase64: string; newKeyBase64: string };

/** What the renderer gets back: the copies, or why a library could not be re-encrypted (nothing rotated then). */
export type RotationReencryptResult =
  | { ok: true; copies: RotationLibraryCopy[] }
  | { ok: false; error: "unreadable" | "not_snapshotted" | "failed"; message: string };

/**
 * PRIV-KEY-06: a key rotation from this desktop re-encrypts every other app's library first. Registered in both
 * library modes (direct SQLite and runtime proxy): it only reads the remote snapshots and uploads their new chunks.
 */
export const registerLibraryRotationIpc = (ipc: IpcMain) => {
  ipc.handle(
    "sf-library-db-reencrypt-for-rotation",
    async (_event, payload: RotationReencryptPayload): Promise<RotationReencryptResult> => {
      try {
        const copies = await reencryptLibrariesForRotation({ ...payload, appIds: OTHER_LIBRARY_APPS });
        return { ok: true, copies };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ event: "rotation_reencrypt_failed", message });
        if (message === "DECRYPT_FAILED") return { ok: false, error: "unreadable", message };
        if (message.startsWith(LIBRARY_NOT_SNAPSHOTTED)) return { ok: false, error: "not_snapshotted", message };
        return { ok: false, error: "failed", message };
      }
    }
  );
};
