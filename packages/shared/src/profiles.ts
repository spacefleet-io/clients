/**
 * Profiles: one account, several viewers sharing the login and the library
 * (ACCT-SQUAD-02, ACCT-PROF-01, ACCT-PROF-02). The API holds the profile list
 * (id, name, avatar, creation date: `GET/POST/PATCH/DELETE /profiles`); only each
 * profile's viewing data stays in the end-to-end encrypted library, the main
 * profile's in the library's own (unprefixed) storage and every other profile's
 * under `p:<profileId>:` keys (the cross-client contract). A profile's picture is
 * one of the built-in pack (`avatarId`, ACCT-PROF-05, `./profileAvatars`).
 */

import type { ProfileFeatures } from "./appFeatures";
import type { ProfileAvatarId } from "./profileAvatars";

/** Profile limits of ACCT-PROF-01: a free account holds one profile, a paid one, on any plan, up to five. */
export const MAX_PROFILES_FREE = 1;
export const MAX_PROFILES_PAID = 5;

/**
 * The palette colours of the profiles made before the avatar pack (ACCT-PROF-05). `avatar` stays an index into this
 * palette (0 to 7) for the apps released before the pack; the API keeps it matching the avatar (`colourForAvatarId`).
 */
export const PROFILE_AVATAR_COLORS: readonly string[] = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export const PROFILE_NAME_MAX = 40;

/**
 * One profile as the API returns it. `isMain` = the oldest profile of the account. `avatarId` = the profile's
 * picture (ACCT-PROF-05); `avatar` = the palette colour matching it, for apps released before the pack. `features` =
 * which app features this profile has set up or put off (`{}` when none; UX-SETUP-10, UX-UPDATE-01, `./appFeatures`).
 */
export type ApiProfile = {
  id: string;
  name: string;
  avatar: number;
  avatarId: ProfileAvatarId;
  createdAt: string;
  isMain: boolean;
  features: ProfileFeatures;
};

/** `GET /profiles` and `DELETE /profiles/:id` body. */
export type ProfilesResponse = { profiles: ApiProfile[]; maxProfiles: number };

/** The profile a playback names when the app has no profile picker (STOR-BW-11): the main one, else the first. */
export const mainProfileId = (profiles: readonly Pick<ApiProfile, "id" | "isMain">[]): string | null =>
  (profiles.find((profile) => profile.isMain) ?? profiles[0])?.id ?? null;

/** Error codes of the `/profiles` routes. */
export const PROFILE_ERRORS = {
  /** 409: the account already holds `maxProfiles` profiles (ACCT-PROF-01). */
  limit: "profile_limit",
  /** 409: deleting the only profile left (ACCT-PROF-02). */
  last: "last_profile",
  /** 400: name is not 1 to 40 code points after trimming, avatar outside 0..7, an avatarId not in the pack, or a feature id or state not in `./appFeatures`. */
  invalid: "invalid_profile",
  /** 404: no such profile on this account. */
  notFound: "profile_not_found",
} as const;

/** Viewing-state key of a non-main profile: `p:<profileId>:<key>`. */
export const profileScopedKey = (profileId: string, key: string): string => {
  if (profileId === "") throw new Error("profileScopedKey: empty profile id");
  return `p:${profileId}:${key}`;
};

/** Prefix of every viewing-state key of a profile: `""` for the main profile, `p:<id>:` otherwise. */
export const profileKeyPrefix = (profile: Pick<ApiProfile, "id" | "isMain">): string =>
  profile.isMain ? "" : profileScopedKey(profile.id, "");

/** The viewer fields of `client_config_v1` a profile owns; the rest stays shared. */
export const PROFILE_CONFIG_KEYS = [
  "uiTheme",
  "trailerLanguages",
  "autoplayNextEpisode",
  "introSkipEnabled",
  "creditsSkipEnabled",
  "skipMode",
] as const;

/** Writers are strict: trimmed name of 1 to `PROFILE_NAME_MAX` Unicode code points (Python `len`), or null. */
export const normalizeProfileName = (raw: string): string | null => {
  const name = raw.trim();
  const length = [...name].length;
  return length >= 1 && length <= PROFILE_NAME_MAX ? name : null;
};

/**
 * Orders an account's profiles oldest first (id breaks ties) and marks the
 * oldest as main: when the main profile is deleted the oldest remaining one
 * becomes main (ACCT-PROF-02).
 */
export const orderProfiles = <T extends { id: string; createdAt: string }>(
  profiles: readonly T[],
): Array<T & { isMain: boolean }> =>
  [...profiles]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((profile, index) => ({ ...profile, isMain: index === 0 }));

/** A client refuses a new profile once the count reaches the plan limit; the API refuses it too. */
export const canCreateProfile = (liveCount: number, maxProfiles: number): boolean => liveCount < maxProfiles;

/** Any profile can be deleted while another one remains (ACCT-PROF-02). */
export const canDeleteProfile = (liveCount: number): boolean => liveCount > 1;
