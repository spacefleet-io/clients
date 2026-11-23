export const SPACE_APP_HEADER = "x-space-app";

export const SPACE_APP_IDS = ["badger", "parrot"] as const;

export type SpaceAppId = (typeof SPACE_APP_IDS)[number];

export const DEFAULT_SPACE_APP_ID: SpaceAppId = "badger";

export const isSpaceAppId = (value: string): value is SpaceAppId =>
  (SPACE_APP_IDS as readonly string[]).includes(value);

export const normalizeSpaceAppId = (value: unknown): SpaceAppId | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return isSpaceAppId(normalized) ? normalized : null;
};

/** The app's name as people see it; the same in every language ("Parrot on Studio laptop wants to sign in", ACCT-PAIR-05). */
export const SPACE_APP_NAMES: Record<SpaceAppId, string> = {
  badger: "Badger",
  parrot: "Parrot",
};
