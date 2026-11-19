// @vitest-environment jsdom
/**
 * The shared profile screens (`src/profiles.tsx`) against ACCT-PROF-05, UX-PROF-01 and UX-TOP-01: avatars drawn from
 * the pack, the chooser in the manager's edit step, the "Add profile" tile, and the top bar's avatar menu.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { createProfileStore } from "@space/shared/profileStore";
import { profilesTranslator } from "@space/shared/profileTexts";
import { ProfileMenu, ProfilesManager, WhoIsWatchingPanel, type ProfilesScreenDeps } from "../src/profiles";

const log = (event: string, data: Record<string, unknown>) => console.info("[ui-profiles.test]", event, JSON.stringify(data));

const profile = (id: string, name: string, avatar: number, avatarId: ProfileAvatarId | null, isMain = false): ApiProfile =>
  ({ id, name, avatar, avatarId, createdAt: "2026-11-01T00:00:00Z", isMain }) as ApiProfile;

const setup = async (initial: ApiProfile[], { active }: { active?: string } = {}) => {
  let profiles = initial;
  const sent: { create: unknown[]; update: unknown[] } = { create: [], update: [] };
  const response = (): ProfilesResponse => ({ profiles, maxProfiles: 5 });
  const saved = new Map<string, string>();
  const store = createProfileStore({
    storage: {
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => void saved.set(key, value),
      removeItem: async (key) => void saved.delete(key),
    },
    api: {
      list: async () => response(),
      create: async (_token, body) => {
        sent.create.push(body);
        const created = profile(`p-${profiles.length + 1}`, body.name, 0, body.avatarId ?? null);
        profiles = [...profiles, created];
        return { ...response(), profile: created };
      },
      update: async (_token, id, body) => {
        sent.update.push({ id, ...body });
        profiles = profiles.map((entry) => (entry.id === id ? { ...entry, ...body } : entry));
        return { ...response(), profile: profiles.find((entry) => entry.id === id)! };
      },
      remove: async () => response(),
    },
    applyScope: () => undefined,
    log,
  });
  await store.startSession({ userId: "u1", token: "t", askEveryStart: true });
  await store.refresh();
  if (active) await store.selectProfile(active);
  const deps: ProfilesScreenDeps = { store, deleteProfile: async () => undefined, log, t: profilesTranslator("en") };
  return { store, deps, sent };
};

const avatarOf = (root: ParentNode, testId: string) => root.querySelector(`[data-testid="${testId}"] [data-testid="profile-avatar"]`)?.getAttribute("data-avatar");

afterEach(cleanup);

describe("shared profile screens", () => {
  /** @req ACCT-PROF-05 @req UX-PROF-01 */
  it("Who's watching? draws each profile's avatar, a profile from before the pack as its colour's, and an Add profile tile", async () => {
    const { deps } = await setup([profile("p1", "Chris", 5, "badger", true), profile("p2", "Marie", 1, null)]);
    const { container } = render(<WhoIsWatchingPanel {...deps} />);
    expect(avatarOf(container, "profile-tile-p1")).toBe("badger");
    // Orange from before the pack reads as the fox.
    expect(avatarOf(container, "profile-tile-p2")).toBe("fox");
    expect(screen.getByTestId("profile-tile-add").textContent).toContain("Add profile");
  });

  /** @req ACCT-PROF-05 @req UX-SETUP-10 */
  it("@req UX-SETUP-10 Add profile opens the chooser on the first unused avatar; the picked avatar is sent with the new profile, marked set up", async () => {
    const { deps, sent, store } = await setup([profile("p1", "Chris", 5, "badger", true)]);
    render(<WhoIsWatchingPanel {...deps} />);
    fireEvent.click(screen.getByTestId("profile-tile-add"));
    const chooser = screen.getByTestId("avatar-chooser");
    expect(chooser.querySelectorAll("button")).toHaveLength(22);
    // Badger is taken, so the new profile starts on the parrot.
    expect(screen.getByTestId("profile-avatar-preview").getAttribute("data-avatar")).toBe("parrot");
    expect(screen.getByTestId("avatar-option-parrot").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("avatar-option-dino").getAttribute("aria-label")).toBe("Dino");
    fireEvent.click(screen.getByTestId("avatar-option-dino"));
    expect(screen.getByTestId("profile-avatar-preview").getAttribute("data-avatar")).toBe("dino");
    fireEvent.change(screen.getByTestId("profile-name-input"), { target: { value: "Léo" } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("profile-edit"));
    });
    // The avatar was picked here, so the new profile skips the "Your profile" step.
    expect(sent.create).toEqual([{ name: "Léo", avatarId: "dino", features: { avatars: "set" } }]);
    expect(store.getSnapshot().profiles.find((p) => p.name === "Léo")?.avatarId).toBe("dino");
    // Saving an added profile goes back to the tiles.
    expect(screen.getByTestId("profile-tile-p-2")).toBeTruthy();
  });

  /** @req ACCT-PROF-05 */
  it("Edit changes the name and the avatar of a profile, starting from its own avatar", async () => {
    const { deps, sent } = await setup([profile("p1", "Chris", 5, "badger", true), profile("p2", "Kids", 4, "panda")]);
    render(<ProfilesManager {...deps} />);
    fireEvent.click(screen.getByTestId("profile-edit-p2"));
    expect(screen.getByTestId("profile-avatar-preview").getAttribute("data-avatar")).toBe("panda");
    fireEvent.click(screen.getByTestId("avatar-option-rocket"));
    await act(async () => {
      fireEvent.submit(screen.getByTestId("profile-edit"));
    });
    expect(sent.update).toEqual([{ id: "p2", name: "Kids", avatarId: "rocket" }]);
    expect(avatarOf(document, "profile-row-p2")).toBe("rocket");
  });

  /** @req UX-TOP-01 */
  it("the avatar menu with one profile shows it ticked, then Add profile, Manage profiles and Sign out", async () => {
    const { deps } = await setup([profile("p1", "Chris", 5, "badger", true)]);
    const actions = { onAddProfile: vi.fn(), onManageProfiles: vi.fn(), onSignOut: vi.fn() };
    render(<ProfileMenu store={deps.store} log={log} t={deps.t} signOutLabel="Sign out" {...actions} />);
    const trigger = screen.getByTestId("profile-menu");
    expect(trigger.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("badger");
    expect(trigger.getAttribute("aria-label")).toBe("Profile menu (Chris)");
    fireEvent.click(trigger);
    const items = [...screen.getByTestId("profile-menu-list").querySelectorAll("[role^=menuitem]")].map((el) => el.textContent);
    expect(items).toEqual(["Chris", "Add profile", "Manage profiles", "Sign out"]);
    expect(screen.getByTestId("profile-menu-p1").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("profile-menu-sign-out"));
    expect(actions.onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("profile-menu-list")).toBeNull();
  });

  /** @req UX-TOP-01 */
  it("the avatar menu with several profiles ticks the current one and switches on a pick without signing in", async () => {
    const { deps, store } = await setup([profile("p1", "Chris", 5, "badger", true), profile("p2", "Marie", 1, "fox")], { active: "p2" });
    const actions = { onAddProfile: vi.fn(), onManageProfiles: vi.fn(), onSignOut: vi.fn() };
    render(<ProfileMenu store={store} log={log} t={deps.t} signOutLabel="Sign out" {...actions} />);
    expect(screen.getByTestId("profile-menu").querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("fox");
    fireEvent.click(screen.getByTestId("profile-menu"));
    expect(screen.getByTestId("profile-menu-p1").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("profile-menu-p2").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByTestId("profile-menu-p1"));
    });
    expect(store.getSnapshot().activeId).toBe("p1");
    expect(screen.getByTestId("profile-menu").querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("badger");
    fireEvent.click(screen.getByTestId("profile-menu"));
    fireEvent.click(screen.getByTestId("profile-menu-manage"));
    expect(actions.onManageProfiles).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("profile-menu"));
    fireEvent.keyDown(screen.getByTestId("profile-menu-list"), { key: "Escape" });
    expect(screen.queryByTestId("profile-menu-list")).toBeNull();
  });
});
