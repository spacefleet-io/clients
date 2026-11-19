/**
 * The built-in profile avatar pack (ACCT-PROF-05): exactly 22 pictures, one flat list with no categories and no
 * uploads. A profile stores the id of one of them (`ApiProfile.avatarId`), which the API keeps with the profile so
 * every device shows the same one. The pictures themselves live in `@space/profile-avatars` (`web` and `native`
 * entries, one size set per client); this module is the contract every app and the API share.
 *
 * Profiles made before the pack hold only a palette colour (`ApiProfile.avatar`, an index into
 * `PROFILE_AVATAR_COLORS`). Each colour maps to the avatar whose tile has that colour (`avatarIdForColour`), and each
 * avatar maps back to the palette colour nearest its tile (`colourForAvatarId`), so an app released before the pack
 * still draws a matching colour and a colour it sets still gives a matching avatar.
 */

/** Pack order = chooser order: the two mascots, then the animals, then space. */
export const PROFILE_AVATAR_IDS = [
  "badger",
  "parrot",
  "fox",
  "cat",
  "dog",
  "owl",
  "bear",
  "raccoon",
  "octopus",
  "panda",
  "penguin",
  "bunny",
  "dino",
  "frog",
  "whale",
  "moon",
  "alien",
  "robot",
  "rocket",
  "planet",
  "ufo",
  "earth",
] as const;

export type ProfileAvatarId = (typeof PROFILE_AVATAR_IDS)[number];

export const isProfileAvatarId = (value: unknown): value is ProfileAvatarId =>
  typeof value === "string" && (PROFILE_AVATAR_IDS as readonly string[]).includes(value);

/**
 * Palette colour (index into `PROFILE_AVATAR_COLORS`: 0 red, 1 orange, 2 yellow, 3 green, 4 teal, 5 blue, 6 violet,
 * 7 pink) nearest each avatar's tile.
 */
const AVATAR_COLOUR: Record<ProfileAvatarId, number> = {
  badger: 5,
  parrot: 3,
  fox: 1,
  cat: 6,
  dog: 1,
  owl: 6,
  bear: 3,
  raccoon: 0,
  octopus: 4,
  panda: 4,
  penguin: 5,
  bunny: 7,
  dino: 3,
  frog: 3,
  whale: 5,
  moon: 2,
  alien: 6,
  robot: 5,
  rocket: 4,
  planet: 6,
  ufo: 2,
  earth: 5,
};

/** The avatar a profile with only a palette colour gets: the one whose tile has that colour. */
const COLOUR_AVATAR: readonly ProfileAvatarId[] = ["raccoon", "fox", "moon", "frog", "panda", "badger", "cat", "bunny"];

export const colourForAvatarId = (id: ProfileAvatarId): number => AVATAR_COLOUR[id];

/** Out-of-range colours (never stored: the API checks 0..7) fall back to the first avatar. */
export const avatarIdForColour = (colour: number): ProfileAvatarId => COLOUR_AVATAR[colour] ?? PROFILE_AVATAR_IDS[0];

/** A profile's avatar: its stored id, else the one matching its colour (a row written before the pack). */
export const profileAvatarIdOf = (profile: { avatarId?: string | null; avatar: number }): ProfileAvatarId =>
  isProfileAvatarId(profile.avatarId) ? profile.avatarId : avatarIdForColour(profile.avatar);

/** An add form's preselected avatar: the first one in pack order no profile of the account uses yet (the first when all are). */
export const nextProfileAvatarId = (used: Iterable<ProfileAvatarId>): ProfileAvatarId => {
  const taken = new Set(used);
  return PROFILE_AVATAR_IDS.find((id) => !taken.has(id)) ?? PROFILE_AVATAR_IDS[0];
};

/**
 * The avatar the API gives a profile created without one, the account's first profile included (ACCT-PROF-05): a
 * random one no profile of the account uses yet, else a random one of the whole pack. `random` returns [0, 1) like
 * `Math.random`, which it defaults to; tests pass their own.
 */
export const randomUnusedProfileAvatarId = (used: Iterable<ProfileAvatarId>, random: () => number = Math.random): ProfileAvatarId => {
  const taken = new Set(used);
  const free = PROFILE_AVATAR_IDS.filter((id) => !taken.has(id));
  const pool: readonly ProfileAvatarId[] = free.length > 0 ? free : PROFILE_AVATAR_IDS;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
};
