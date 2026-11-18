import type { AppId } from "./types";
import { runtimeState } from "./runtime";

export const readBearerToken = (header: string | null) => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

/**
 * The token of a live first-party app session, else null. A tool session
 * (DEV-LIB-01) is always refused here, so every route that existed before
 * tool grants stays closed to tools without being touched; the
 * `/runtime/tool/*` handler reads the bearer itself and lets the grant decide.
 */
export const requireToken = (authHeader: string | null) => {
  const token = readBearerToken(authHeader);
  if (!token) return null;
  const session = runtimeState.requireSession(token);
  if (!session || session.kind === "tool") return null;
  return token;
};

export const requireAppScope = (token: string, app: AppId) => runtimeState.canAccess(token, app);
