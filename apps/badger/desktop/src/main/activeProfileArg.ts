import { readProfileId } from "@space/shared/playbackProfile";

/** The profile the renderer picked, as `sf-library-db-set-active-profile` receives it (ACCT-SQUAD-02). */
export type ActiveProfileArg = { id: string; isMain: boolean };

/**
 * Reads the renderer's set-active-profile argument. `null` clears the profile ("Who's watching?" open, signed out).
 * `undefined` means refused: the id must be a wire profile id (`readProfileId`: non-empty, trimmed, at most 64 chars)
 * with no `:`. An empty id would give the prefix `p::`, which no wipe or op class treats as a profile key, and an id
 * with `:` (`a:b`) falls under another profile's `p:a:` prefix, so wiping `a` would blank it too.
 */
export const parseActiveProfileArg = (arg: unknown): ActiveProfileArg | null | undefined => {
  if (arg === null || arg === undefined) return null;
  if (typeof arg !== "object" || !("id" in arg)) return undefined;
  const profileId = readProfileId(arg.id);
  if (!profileId || profileId.includes(":")) return undefined;
  return { id: profileId, isMain: "isMain" in arg && arg.isMain === true };
};
