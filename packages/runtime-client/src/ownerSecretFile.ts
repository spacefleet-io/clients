/**
 * Node-only: read the runtime's owner secret (RT-SEC-05) from the file the
 * runtime publishes. Kept out of `session.ts` and `index.ts` so renderer
 * bundles never pull `node:fs` in; renderers get the secret from their main
 * process over IPC instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_OWNER_SECRET_FILE, RUNTIME_OWNER_SECRET_HEX_LENGTH } from "@space/runtime-contracts/lifecycle";
import type { OwnerSecretProvider } from "./session";

const SECRET_SHAPE = new RegExp(`^[0-9a-f]{${RUNTIME_OWNER_SECRET_HEX_LENGTH}}$`);

/**
 * The current secret, or null when the runtime has not published one (not
 * started, shut down cleanly) or the file holds something that is not a secret.
 * Read fresh on every call: a restarted runtime issues a new one.
 */
export const readOwnerSecretFile = (dataDir: string): string | null => {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, RUNTIME_OWNER_SECRET_FILE), "utf8").trim();
  } catch {
    return null;
  }
  return SECRET_SHAPE.test(raw) ? raw : null;
};

/** A provider for `createRuntimeSession({ ownerSecret })` bound to a runtime data dir (or a lazy lookup of it). */
export const ownerSecretFileProvider = (dataDir: string | (() => string)): OwnerSecretProvider => () =>
  readOwnerSecretFile(typeof dataDir === "function" ? dataDir() : dataDir);
