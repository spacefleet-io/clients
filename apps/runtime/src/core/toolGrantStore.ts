/**
 * PLAT-WEB-06: the web player's grant outlives the runtime. Only what is
 * needed to recognise its token again is written: the SHA-256 digest of the
 * token, never the token itself and never a key (RT-SEC-05). A leaked file
 * gives nothing that can be presented to the runtime.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolAccessMode } from "@space/tool-access/contracts";

export type PersistedToolGrant = {
  id: string;
  toolName: string;
  mode: ToolAccessMode;
  userId: string;
  origin: string;
  grantedAt: number;
  lastUsedAt: number | null;
  /** Hex SHA-256 of the session token. */
  tokenDigest: string;
};

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isPersistedToolGrant = (value: unknown): value is PersistedToolGrant => {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    isText(grant.id) &&
    isText(grant.toolName) &&
    (grant.mode === "read" || grant.mode === "write") &&
    isText(grant.userId) &&
    isText(grant.origin) &&
    Number.isFinite(grant.grantedAt) &&
    (grant.lastUsedAt === null || Number.isFinite(grant.lastUsedAt)) &&
    typeof grant.tokenDigest === "string" &&
    /^[0-9a-f]{64}$/.test(grant.tokenDigest)
  );
};

const parseFile = (raw: unknown): PersistedToolGrant[] | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.grants) || !file.grants.every(isPersistedToolGrant)) return null;
  return file.grants;
};

export type ToolGrantStore = {
  load(): PersistedToolGrant[];
  save(grants: PersistedToolGrant[]): void;
};

/** JSON file next to the runtime's other stores; written whole, through a temp file and a rename. */
export const fileToolGrantStore = (filePath: string): ToolGrantStore => ({
  load() {
    if (!existsSync(filePath)) return [];
    try {
      const grants = parseFile(JSON.parse(readFileSync(filePath, "utf8")));
      if (grants) return grants;
      console.warn("[tool-access] grant store has an unknown shape; starting without stored grants", { filePath });
    } catch (err) {
      console.warn("[tool-access] grant store unreadable; starting without stored grants", { filePath, err });
    }
    return [];
  },
  save(grants) {
    try {
      if (grants.length === 0) {
        rmSync(filePath, { force: true });
        return;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ version: 1, grants }), { mode: 0o600 });
      renameSync(tmpPath, filePath);
    } catch (err) {
      // The grant still works until the runtime stops; only its survival of a restart is lost.
      console.error("[tool-access] could not write the grant store", { filePath, err });
    }
  },
});
