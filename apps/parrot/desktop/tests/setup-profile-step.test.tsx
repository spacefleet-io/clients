// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PROFILE-STEP-001..004
 * @level unit
 * @req UX-SETUP-10[parrot]
 * @req UX-SETUP-08[parrot]
 * @req UX-SETUP-06[parrot]
 * @why Chris-approved "Your profile" step: in this computer's first setup it comes right after the library key when
 *   the profile was made since the avatars ("Step 2 of 5": key, profile, folders, start at login, error reports).
 *   Next saves the name, the avatar and `features.avatars = "set"` in one PATCH and moves on to the folders. A
 *   profile from before the avatars is never asked: the run counts 4 steps and a run resumed on the step skips it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import type { ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-PROFILE-STEP]";

vi.mock("../src/renderer/src/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: vi.fn(), dialog: null }) }));

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const NEW_PROFILE = "2026-11-20T09:00:00.000Z";
const OLD_PROFILE = "2026-11-01T09:00:00.000Z";

const state: ParrotState = {
  setup: { step: "profile", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

describe("@req UX-SETUP-10 Parrot desktop \"Your profile\" in the first setup", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ParrotState;
  let profiles: ApiProfile[];
  const t = translator("en");
  const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const response = (): ProfilesResponse => ({ profiles, maxProfiles: 5 });
  const listProfiles = vi.fn(async () => ({ ok: true as const, value: response() }));
  const updateProfile = vi.fn(async (id: string, body: Partial<Pick<ApiProfile, "name" | "avatarId" | "features">>) => {
    profiles = profiles.map((entry) => (entry.id === id ? { ...entry, ...body, features: { ...entry.features, ...body.features } } : entry));
    return { ok: true as const, value: { ...response(), profile: profiles.find((entry) => entry.id === id)! } };
  });
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => ({ ...current, setup: { ...current.setup, ...patch } }));
  const render = () => act(() => root.render(<Setup t={t} state={current} onState={(next) => ((current = next), render())} />));
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: step=${current.setup.step} progress=${JSON.stringify(q("setup-progress")?.textContent ?? null)} profileStep=${q("profile-setup-step") !== null} updates=${JSON.stringify(updateProfile.mock.calls)} saves=${JSON.stringify(saveSetup.mock.calls)}`,
    );
  const mount = async (step: ParrotState["setup"]["step"]) => {
    current = { ...state, setup: { ...state.setup, step } };
    await act(async () => render());
    await flush();
    dump(`mounted on ${step}`);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as unknown as { parrot: unknown }).parrot = {
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      listProfiles,
      createProfile: vi.fn(),
      updateProfile,
      deleteProfile: vi.fn(),
      createLibraryKey: vi.fn(async () => ({ ok: false, error: "hasLibrary" })),
      getState: vi.fn(async () => current),
      saveSetup,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("PARROT-DESKTOP-PROFILE-STEP-001: a profile made since the avatars is asked at step 2 of 5; Next saves set and goes to the folders", async () => {
    profiles = [{ id: "p1", name: "Chris", avatar: 5, avatarId: "parrot", createdAt: NEW_PROFILE, isMain: true, features: {} } as ApiProfile];
    await mount("profile");
    expect(q("profile-setup-step")).not.toBeNull();
    expect(q("setup-progress")?.textContent).toBe(t("stepOf", { n: 2, m: 5 }));
    expect((q("profile-setup-name") as HTMLInputElement).value).toBe("Chris");
    await act(async () => q("profile-setup-next")!.click());
    await flush();
    dump("next");
    expect(updateProfile).toHaveBeenCalledWith("p1", { name: "Chris", avatarId: "parrot", features: { avatars: "set" } });
    expect(saveSetup, "one move to the folders: the saved profile does not read as never owed").toHaveBeenCalledTimes(1);
    expect(saveSetup).toHaveBeenLastCalledWith({ step: "folders" });
    expect(q("setup-progress")?.textContent, "the count stays at 5 after the step").toBe(t("stepOf", { n: 3, m: 5 }));
  });

  it("PARROT-DESKTOP-PROFILE-STEP-002: a profile from before the avatars is never asked; a run resumed on the step moves to the folders", async () => {
    profiles = [{ id: "p1", name: "Chris", avatar: 5, avatarId: "parrot", createdAt: OLD_PROFILE, isMain: true, features: {} } as ApiProfile];
    await mount("profile");
    expect(q("profile-setup-step")).toBeNull();
    expect(saveSetup).toHaveBeenCalledWith({ step: "folders" });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(q("setup-progress")?.textContent).toBe(t("stepOf", { n: 2, m: 4 }));
  });

  it("PARROT-DESKTOP-PROFILE-STEP-003: Back from the folders after the step returns to it while it is answered in this run", async () => {
    profiles = [{ id: "p1", name: "Chris", avatar: 5, avatarId: "parrot", createdAt: NEW_PROFILE, isMain: true, features: {} } as ApiProfile];
    await mount("profile");
    await act(async () => q("profile-setup-next")!.click());
    await flush();
    await act(async () => q("setup-back")?.click());
    await flush();
    dump("back");
    expect(current.setup.step).toBe("profile");
    expect(q("profile-setup-step")).not.toBeNull();
  });

  it("PARROT-DESKTOP-PROFILE-STEP-004: each setup step has one Back, at the bottom beside Next, and no Back link at the top", async () => {
    profiles = [{ id: "p1", name: "Chris", avatar: 5, avatarId: "parrot", createdAt: NEW_PROFILE, isMain: true, features: {} } as ApiProfile];
    for (const step of ["profile", "folders", "startAtLogin"] as const) {
      await mount(step);
      const backs = [...document.body.querySelectorAll("button")].filter((button) => button.textContent?.trim() === t("back"));
      const links = [...document.body.querySelectorAll("a")].filter((link) => /back/i.test(link.textContent ?? ""));
      const next = q("profile-setup-next") ?? q("setup-next") ?? q("setup-finish");
      console.info(`${SUITE} 004 ${step}: backButtons=${backs.length} backLinks=${links.length}`);
      expect(backs, step).toHaveLength(1);
      expect(links, step).toHaveLength(0);
      expect(backs[0]!.parentElement, `${step}: Back sits beside Next`).toBe(next?.parentElement);
    }
  });
});
