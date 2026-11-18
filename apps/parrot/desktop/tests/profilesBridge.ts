import { vi, type Mock } from "vitest";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { nextProfileAvatarId, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ParrotProfileAnswer, ParrotProfilesResult } from "../src/shared/ipc";

export type ProfilesBridgeStub = {
  listProfiles: Mock<() => Promise<ParrotProfilesResult<ProfilesResponse>>>;
  createProfile: Mock<(body: { name: string; avatarId?: ProfileAvatarId }) => Promise<ParrotProfilesResult<ParrotProfileAnswer>>>;
  updateProfile: Mock<(id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => Promise<ParrotProfilesResult<ParrotProfileAnswer>>>;
  deleteProfile: Mock<(id: string) => Promise<ParrotProfilesResult<ProfilesResponse>>>;
};

export const stubProfile = (id: string, name: string, avatarId: ProfileAvatarId, isMain = false): ApiProfile => ({
  id,
  name,
  avatar: 0,
  avatarId,
  createdAt: "2026-11-16T00:00:00.000Z",
  isMain,
});

/**
 * The window bridge's profile calls (ACCT-PROF-01..05) answered from a list held in memory, for suites that need the
 * top-bar avatar menu (UX-TOP-02) or Settings ▸ Profiles without an API. One main profile by default.
 */
export const profilesBridgeStub = (
  start: ApiProfile[] = [stubProfile("p-main", "Chris", "badger", true)],
  maxProfiles = 5,
): ProfilesBridgeStub => {
  let profiles = [...start];
  const answer = (profile: ApiProfile) => ({ ok: true as const, value: { profiles: [...profiles], maxProfiles, profile } });
  return {
    listProfiles: vi.fn(async () => ({ ok: true as const, value: { profiles: [...profiles], maxProfiles } })),
    createProfile: vi.fn(async (body: { name: string; avatarId?: ProfileAvatarId }) => {
      const profile = stubProfile(`p-${profiles.length + 1}`, body.name, body.avatarId ?? nextProfileAvatarId(profiles.map((p) => p.avatarId)));
      profiles = [...profiles, profile];
      return answer(profile);
    }),
    updateProfile: vi.fn(async (id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => {
      profiles = profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
      return answer(profiles.find((p) => p.id === id)!);
    }),
    deleteProfile: vi.fn(async (id: string) => {
      profiles = profiles.filter((p) => p.id !== id);
      return { ok: true as const, value: { profiles: [...profiles], maxProfiles } };
    }),
  };
};
