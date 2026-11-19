/**
 * @test-id SHARED-PROFILE-AVATARS-001
 * @level unit
 *
 * ACCT-PROF-05: the built-in avatar pack every app and the API share. Exactly 22 avatars in one flat list; each palette
 * colour of the profiles made before the pack maps to a matching avatar and back; a new profile gets the first avatar
 * no profile uses yet.
 */
import { describe, expect, it } from "vitest";
import {
  PROFILE_AVATAR_IDS,
  avatarIdForColour,
  colourForAvatarId,
  isProfileAvatarId,
  nextProfileAvatarId,
  profileAvatarIdOf,
  randomUnusedProfileAvatarId,
} from "../src/profileAvatars";
import { PROFILE_AVATAR_COLORS } from "../src/profiles";
import { profilesTexts, profilesTranslator } from "../src/profileTexts";

describe("profile avatar pack", () => {
  it("@req ACCT-PROF-05 holds exactly 22 distinct lower-case ids, mascots first", () => {
    expect(PROFILE_AVATAR_IDS).toHaveLength(22);
    expect(new Set(PROFILE_AVATAR_IDS).size).toBe(22);
    for (const id of PROFILE_AVATAR_IDS) expect(id).toMatch(/^[a-z]+$/);
    expect(PROFILE_AVATAR_IDS.slice(0, 2)).toEqual(["badger", "parrot"]);
  });

  it("@req ACCT-PROF-05 accepts only the pack's ids", () => {
    for (const id of PROFILE_AVATAR_IDS) expect(isProfileAvatarId(id)).toBe(true);
    for (const bad of ["", "Fox", "unicorn", 3, null, undefined, {}]) expect(isProfileAvatarId(bad)).toBe(false);
  });

  it("@req ACCT-PROF-05 every palette colour maps to an avatar whose colour is that one", () => {
    const mapped = PROFILE_AVATAR_COLORS.map((_, colour) => avatarIdForColour(colour));
    console.info(`[profile-avatars] colour -> avatar: ${JSON.stringify(mapped)}`);
    expect(mapped).toEqual(["raccoon", "fox", "moon", "frog", "panda", "badger", "cat", "bunny"]);
    PROFILE_AVATAR_COLORS.forEach((_, colour) => expect(colourForAvatarId(avatarIdForColour(colour))).toBe(colour));
    expect(new Set(mapped).size).toBe(PROFILE_AVATAR_COLORS.length);
  });

  it("@req ACCT-PROF-05 every avatar has a palette colour for apps released before the pack", () => {
    for (const id of PROFILE_AVATAR_IDS) {
      const colour = colourForAvatarId(id);
      expect(Number.isInteger(colour) && colour >= 0 && colour < PROFILE_AVATAR_COLORS.length).toBe(true);
    }
  });

  it("@req ACCT-PROF-05 a profile reads its stored id, else the avatar matching its colour", () => {
    expect(profileAvatarIdOf({ avatarId: "owl", avatar: 0 })).toBe("owl");
    expect(profileAvatarIdOf({ avatarId: null, avatar: 3 })).toBe("frog");
    expect(profileAvatarIdOf({ avatar: 7 })).toBe("bunny");
    expect(profileAvatarIdOf({ avatarId: "unicorn", avatar: 1 })).toBe("fox");
    expect(profileAvatarIdOf({ avatar: 42 })).toBe("badger");
  });

  it("@req ACCT-PROF-05 a new profile gets the first avatar nobody uses, the first when all are taken", () => {
    expect(nextProfileAvatarId([])).toBe("badger");
    expect(nextProfileAvatarId(["badger", "parrot"])).toBe("fox");
    expect(nextProfileAvatarId(["parrot"])).toBe("badger");
    expect(nextProfileAvatarId(PROFILE_AVATAR_IDS)).toBe("badger");
  });

  it("@req ACCT-PROF-05 a profile made without a choice gets a random avatar nobody uses, any one when all are taken", () => {
    // The 20 unused avatars when badger and parrot are taken run fox … earth; index 10 of them is the dino.
    expect(randomUnusedProfileAvatarId(["badger", "parrot"], () => 0)).toBe("fox");
    expect(randomUnusedProfileAvatarId(["badger", "parrot"], () => 0.5)).toBe("dino");
    expect(randomUnusedProfileAvatarId(["badger", "parrot"], () => 0.999999)).toBe("earth");
    expect(randomUnusedProfileAvatarId([], () => 0.5)).toBe("bunny");
    // A random source that reaches 1 still lands on the last avatar.
    expect(randomUnusedProfileAvatarId([], () => 1)).toBe("earth");
    expect(randomUnusedProfileAvatarId(PROFILE_AVATAR_IDS, () => 0.2)).toBe("dog");
    const drawn = new Set(Array.from({ length: 200 }, () => randomUnusedProfileAvatarId(["badger", "fox"])));
    console.info(`[profile-avatars] 200 draws with badger and fox used: ${[...drawn].join(",")}`);
    expect(drawn.has("badger") || drawn.has("fox")).toBe(false);
    expect(drawn.size).toBeGreaterThan(5);
  });

  it("@req ACCT-PROF-05 every avatar has a name in each of the 5 languages, and the chooser its title", () => {
    for (const [language, texts] of Object.entries(profilesTexts)) {
      expect(Object.keys(texts.avatars).sort(), language).toEqual([...PROFILE_AVATAR_IDS].sort());
      for (const name of Object.values(texts.avatars)) expect(name.trim(), language).not.toBe("");
      expect(texts.chooseAvatar, language).not.toBe("");
    }
    expect(profilesTranslator("fr")("profiles.avatars.ufo")).toBe("Soucoupe volante");
    expect(profilesTranslator("de")("profiles.avatarLabel", { name: "Fuchs" })).toBe("Avatar: Fuchs");
    expect(profilesTranslator("en")("profiles.errors.last")).toBe("An account always keeps at least one profile.");
  });

  it("@req UX-I18N-13 the mascot avatars keep their product name in every language, the other animals are translated", () => {
    for (const [language, texts] of Object.entries(profilesTexts)) {
      console.info(`[profile-avatars] ${language}: badger=${texts.avatars.badger} parrot=${texts.avatars.parrot} fox=${texts.avatars.fox}`);
      expect(texts.avatars.badger, language).toBe("Badger");
      expect(texts.avatars.parrot, language).toBe("Parrot");
      expect(profilesTranslator(language as keyof typeof profilesTexts)("profiles.avatarLabel", { name: texts.avatars.badger })).toMatch(/: Badger$/);
    }
    expect(profilesTexts.fr.avatars.fox).toBe("Renard");
  });
});
