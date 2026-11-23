// @vitest-environment jsdom
/**
 * Desktop profile screens: "Who's watching?" in front of the app (UX-PROF-01/02), the one-step switch (UX-PROF-01)
 * and the Profiles section of Settings that creates, renames and deletes profiles (ACCT-PROF-01, ACCT-PROF-02).
 * Every profile is shown and treated the same: nothing says which one is the library's "main" storage.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[profiles-screens]";
const CHRIS = { id: "p-chris", name: "Chris", avatar: 5, avatarId: "badger" as const, isMain: true, createdAt: "2026-10-01T00:00:00.000Z" } as ApiProfile;
const KIDS = { id: "p-kids", name: "Kids", avatar: 7, avatarId: "bunny" as const, isMain: false, createdAt: "2026-10-02T00:00:00.000Z" } as ApiProfile;

const api = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@/api", async () => {
  const shared = await vi.importActual<typeof import("@space/shared/api")>("@space/shared/api");
  return { ApiError: shared.ApiError, ...api };
});
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
}));
vi.mock("@/auth", () => ({ useAuth: () => ({ user: { id: "user-1" }, token: "tok", loading: false }) }));
// The title-language question (ACCT-PROF-03) needs the open library; its own tests cover it.
vi.mock("../src/renderer/src/components/profiles/TitleLanguageGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ProfileGate from "../src/renderer/src/components/profiles/ProfileGate";
import ProfilesSection from "../src/renderer/src/components/settings/sections/ProfilesSection";
import { attachProfileLibrary, profileStore } from "../src/renderer/src/lib/profileStore";

const bridgeSetActiveProfile = vi.fn();
const moves = {
  ensureReady: vi.fn(async () => undefined),
  wipeProfileViewing: vi.fn(async () => undefined),
  promoteProfileToMain: vi.fn(async () => undefined),
  healMainPromotion: vi.fn(async () => undefined),
  listViewingProfileIds: vi.fn(async () => []),
};

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const dump = (label: string) =>
  console.error(
    `${LOG} ${label}`,
    JSON.stringify({
      snapshot: profileStore.getSnapshot(),
      bridgeCalls: bridgeSetActiveProfile.mock.calls,
      api: {
        create: api.createProfile.mock.calls,
        update: api.updateProfile.mock.calls,
        remove: api.deleteProfile.mock.calls,
      },
      moves: Object.fromEntries(Object.entries(moves).map(([name, fn]) => [name, fn.mock.calls])),
    }),
    `\nDOM:\n${container?.innerHTML}`,
  );

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  const el = byTestId(id);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  console.info(`${LOG} click ${id}`);
  await act(async () => {
    el.click();
  });
  await flush();
};
const type = async (id: string, value: string) => {
  const input = byTestId(id) as HTMLInputElement | null;
  if (!input) throw new Error(`missing input ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const startSession = async (list: ProfilesResponse) => {
  api.listProfiles.mockResolvedValue(list);
  await act(async () => {
    await profileStore.startSession({ userId: "user-1", token: "tok", askEveryStart: true });
  });
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const render = async (node: React.ReactNode, url = "/settings?section=profiles") => {
  // ProfileGate lazy-loads the picker: have the module transformed first so the lazy import settles within a flush.
  await import("../src/renderer/src/components/profiles/WhoIsWatching");
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        {node}
        <Where />
      </MemoryRouter>,
    );
  });
  await flush();
};

describe("desktop profile screens", () => {
  beforeEach(async () => {
    localStorage.clear();
    bridgeSetActiveProfile.mockReset();
    bridgeSetActiveProfile.mockResolvedValue({ applied: true });
    (window as unknown as { sf: unknown }).sf = { libraryDb: { setActiveProfile: bridgeSetActiveProfile } };
    for (const fn of Object.values(moves)) fn.mockClear();
    attachProfileLibrary(moves);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await profileStore.endSession("user-1");
  });

  // @req UX-PROF-01[badger-desktop]
  // @req UX-PROF-02[badger-desktop]
  it("shows Who's watching? over the app until a profile is picked, with no profile marked as main", async () => {
    try {
      await startSession({ profiles: [CHRIS, KIDS], maxProfiles: 5 });
      await render(
        <ProfileGate>
          <div data-testid="app-content">app</div>
        </ProfileGate>,
      );
      expect(byTestId("profiles-picker")).not.toBeNull();
      expect(byTestId("app-content")).toBeNull();
      expect(container.textContent).toContain("profiles.whoIsWatching");
      expect(container.textContent).toContain("Chris");
      expect(container.textContent).toContain("Kids");
      expect(container.textContent?.toLowerCase()).not.toContain("main");

      await click(`profile-tile-${KIDS.id}`);
      dump("after pick");
      expect(byTestId("app-content")).not.toBeNull();
      expect(profileStore.getSnapshot().activeId).toBe(KIDS.id);
      expect(bridgeSetActiveProfile).toHaveBeenLastCalledWith({ id: KIDS.id, isMain: false });
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req UX-PROF-01[badger-desktop]
  // @req ACCT-PROF-05[badger-desktop]
  it("draws each profile with its avatar from the pack, as the phone and the TV do", async () => {
    try {
      const older = { ...KIDS, id: "p-older", name: "Older", avatar: 1, avatarId: null } as unknown as ApiProfile;
      await startSession({ profiles: [CHRIS, KIDS, older], maxProfiles: 5 });
      await render(
        <ProfileGate>
          <div data-testid="app-content">app</div>
        </ProfileGate>,
      );
      const avatars = Object.fromEntries(
        [...container.querySelectorAll<HTMLElement>("[data-testid^='profile-tile-']:not([data-testid='profile-tile-add'])")].map((tile) => [
          tile.dataset.testid,
          tile.querySelector<HTMLElement>("[data-testid='profile-avatar']")?.dataset.avatar ?? null,
        ]),
      );
      console.info(`${LOG} avatars`, JSON.stringify(avatars));
      // A profile from before the pack (no avatar id, colour 1 = orange) reads as the fox.
      expect(avatars).toEqual({
        [`profile-tile-${CHRIS.id}`]: "badger",
        [`profile-tile-${KIDS.id}`]: "bunny",
        "profile-tile-p-older": "fox",
      });
      expect(byTestId("profile-tile-add")).not.toBeNull();
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req UX-PROF-01[badger-desktop]
  // The one-step switch also lives in Settings → Profiles, next to the top bar's avatar menu (UX-TOP-01).
  it("switches profile in one step from Settings → Profiles", async () => {
    try {
      await startSession({ profiles: [CHRIS, KIDS], maxProfiles: 5 });
      await act(async () => profileStore.selectProfile(CHRIS.id));
      await render(
        <ProfileGate>
          <ProfilesSection />
        </ProfileGate>,
      );
      expect(container.textContent).toContain("Chris");
      await click("settings-profile-switch");
      expect(byTestId("profiles-picker")).not.toBeNull();
      await click(`profile-tile-${KIDS.id}`);
      dump("after switch");
      expect(profileStore.getSnapshot().activeId).toBe(KIDS.id);
      expect(byTestId("profiles-picker")).toBeNull();
      expect(byTestId("settings-profile-switch")).not.toBeNull();
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-PROF-01[badger-desktop]
  it("creates and renames a profile from Settings, and stops at the plan's limit", async () => {
    try {
      await startSession({ profiles: [CHRIS], maxProfiles: 2 });
      await render(<ProfilesSection />);
      const created = { id: "p-new", name: "Guest", avatar: 5, avatarId: "parrot" as const, isMain: false, createdAt: "2026-10-03T00:00:00.000Z" } as ApiProfile;
      api.createProfile.mockResolvedValue({ profiles: [CHRIS, created], maxProfiles: 2, profile: created });
      await click("profile-add");
      await type("profile-name-input", "  Guest ");
      await click("profile-save");
      expect(api.createProfile).toHaveBeenCalledWith("tok", { name: "Guest", avatarId: "parrot" });
      expect(container.textContent).toContain("Guest");

      const renamed = { ...created, name: "Grandma" };
      api.updateProfile.mockResolvedValue({ profiles: [CHRIS, renamed], maxProfiles: 2, profile: renamed });
      await click(`profile-edit-${created.id}`);
      await type("profile-name-input", "Grandma");
      await click("profile-save");
      expect(api.updateProfile).toHaveBeenCalledWith("tok", created.id, { name: "Grandma", avatarId: "parrot" });
      expect(container.textContent).toContain("Grandma");

      dump("at limit");
      expect((byTestId("profile-add") as HTMLButtonElement).disabled).toBe(true);
      await click("profile-add");
      expect(api.createProfile).toHaveBeenCalledTimes(1);
      expect(byTestId("profile-add-limit")?.textContent).toContain("profiles.errors.limit");
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-PROF-01[badger-desktop]
  // @req ACCT-PROF-05[badger-desktop]
  it("opening Settings → Profiles again shows profiles added and edited on the website", async () => {
    try {
      await startSession({ profiles: [CHRIS], maxProfiles: 5 });
      await render(<ProfilesSection />);
      expect(container.textContent).toContain("Chris");
      await act(async () => root.unmount());
      root = createRoot(container);
      const renamed = { ...CHRIS, name: "Christopher", avatarId: "fox" as const };
      api.listProfiles.mockResolvedValue({ profiles: [renamed, KIDS], maxProfiles: 5 });
      await render(<ProfilesSection />);
      dump("after reopening");
      expect(byTestId(`profile-row-${KIDS.id}`)).not.toBeNull();
      expect(byTestId(`profile-row-${CHRIS.id}`)?.textContent).toContain("Christopher");
      expect(container.querySelector(`[data-testid="profile-row-${CHRIS.id}"] [data-testid="profile-avatar"]`)?.getAttribute("data-avatar")).toBe("fox");
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-PROF-02[badger-desktop]
  it("deletes any profile after a confirmation, the first one included, and its library data moves", async () => {
    try {
      await startSession({ profiles: [CHRIS, KIDS], maxProfiles: 5 });
      await act(async () => profileStore.selectProfile(KIDS.id));
      await render(<ProfilesSection />);
      await click(`profile-delete-${CHRIS.id}`);
      expect(api.deleteProfile).not.toHaveBeenCalled();
      expect(container.textContent).toContain("profiles.deleteBody");
      await click("profile-delete-cancel");
      expect(api.deleteProfile).not.toHaveBeenCalled();

      api.deleteProfile.mockResolvedValue({ profiles: [{ ...KIDS, isMain: true }], maxProfiles: 5 });
      await click(`profile-delete-${CHRIS.id}`);
      await click("profile-delete-confirm");
      dump("after delete");
      expect(api.deleteProfile).toHaveBeenCalledWith("tok", CHRIS.id);
      expect(moves.promoteProfileToMain).toHaveBeenCalledWith(KIDS.id);
      expect(profileStore.getSnapshot().profiles.map((p) => p.id)).toEqual([KIDS.id]);
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-PROF-02[badger-desktop]
  it("shows the last-profile message when the API refuses with 409 last_profile", async () => {
    try {
      await startSession({ profiles: [CHRIS, KIDS], maxProfiles: 5 });
      await act(async () => profileStore.selectProfile(CHRIS.id));
      await render(<ProfilesSection />);
      api.deleteProfile.mockRejectedValue(new ApiError(409, { error: "last_profile" }));
      await click(`profile-delete-${KIDS.id}`);
      await click("profile-delete-confirm");
      dump("after refused delete");
      expect(byTestId("profiles-error")?.textContent).toContain("profiles.errors.last");
      expect(moves.wipeProfileViewing).not.toHaveBeenCalled();
    } catch (error) {
      dump("failed");
      throw error;
    }
  });

  // @req ACCT-PROF-05[badger-desktop]
  // @req UX-TOP-01[badger-desktop]
  it("Add profile from the avatar menu opens Settings → Profiles on a new profile with the avatar chooser", async () => {
    try {
      await startSession({ profiles: [CHRIS], maxProfiles: 5 });
      await render(<ProfilesSection />, "/settings?section=profiles&add=1");
      expect(byTestId("profile-edit")).not.toBeNull();
      expect(container.querySelectorAll('[data-testid^="avatar-option-"]')).toHaveLength(22);
      // The badger is taken by the first profile, so the new profile starts on the next avatar of the pack.
      expect(byTestId("profile-avatar-preview")?.dataset.avatar).toBe("parrot");
      await click("avatar-option-rocket");
      const created = { id: "p-new", name: "Léo", avatar: 5, avatarId: "rocket" as const, isMain: false, createdAt: "2026-10-03T00:00:00.000Z" } as ApiProfile;
      api.createProfile.mockResolvedValue({ profiles: [CHRIS, created], maxProfiles: 5, profile: created });
      await type("profile-name-input", "Léo");
      await click("profile-save");
      dump("after add");
      expect(api.createProfile).toHaveBeenCalledWith("tok", { name: "Léo", avatarId: "rocket" });
      expect(byTestId("where")!.textContent).toBe("/settings?section=profiles");
      expect(byTestId(`profile-row-${created.id}`)?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("rocket");
    } catch (error) {
      dump("failed");
      throw error;
    }
  });
});
