// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PROFILES-001
 * @level integration (real ProfilesSection, shared profile store and manager over jsdom; main's IPC answers faked
 *   with the API's own rules: 5 profiles on a paid plan, `MAX_PROFILES_FREE` on Free, `profile_limit` and `last_profile`)
 * @req ACCT-PROF-01
 * @req ACCT-PROF-02
 * @req ACCT-PROF-05
 * @why Parrot desktop had no way to see or change the account's profiles. Settings ▸ Account now lists them with their
 *   avatars; a paid account adds up to 5, a free one keeps 1, any profile can be deleted while another remains, and a
 *   profile's name and avatar are edited with the shared chooser (ACCT-PROF-05).
 */
import { setTimeout } from "node:timers/promises";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROFILES_FREE } from "@space/shared/profiles";
import { ProfileActionError } from "@space/shared/profileStore";
import { profilesTexts } from "@space/shared/profileTexts";
import type { ApiProfile } from "@space/shared/profiles";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ProfileStore } from "@space/shared/profileStore";
import { createParrotDesktopProfileStore, ProfilesSection, type ParrotProfilesBridge } from "../src/renderer/src/profiles";
import type { ParrotProfilesResult } from "../src/shared/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-PROFILES-001]";
const EN = profilesTexts.en;

/** Main's answers for one account, refusing as the API's profiles service does. */
const fakeMain = (plan: string) => {
  let maxProfiles = plan === "free" ? MAX_PROFILES_FREE : 5;
  let profiles: ApiProfile[] = [{ id: "p-0", name: "Chris", avatar: 0, avatarId: "raccoon", createdAt: "2026-11-11T00:00:00.000Z", isMain: true }];
  let next = 1;
  const calls: string[] = [];
  const ok = <T,>(value: T): Promise<ParrotProfilesResult<T>> => Promise.resolve({ ok: true, value });
  const refuse = (code: string): Promise<{ ok: false; status: number; code: string }> => Promise.resolve({ ok: false, status: 409, code });
  return {
    calls,
    profiles: () => profiles,
    /** The plan dialog moves the account to a paid plan. */
    upgrade: () => {
      maxProfiles = 5;
    },
    /** Another device adds a profile behind this window's back. */
    addElsewhere: (name: string) => {
      profiles = [...profiles, { id: `p-${next++}`, name, avatar: 0, avatarId: "raccoon" as const, createdAt: new Date().toISOString(), isMain: false }];
    },
    bridge: {
      listProfiles: () => {
        calls.push("list");
        return ok({ profiles, maxProfiles });
      },
      createProfile: ({ name, avatarId }: { name: string; avatarId?: ProfileAvatarId }) => {
        calls.push(avatarId ? `create ${name} ${avatarId}` : `create ${name}`);
        if (profiles.length >= maxProfiles) return refuse("profile_limit");
        const profile = { id: `p-${next++}`, name, avatar: 0, avatarId: avatarId ?? ("raccoon" as const), createdAt: new Date().toISOString(), isMain: false };
        profiles = [...profiles, profile];
        return ok({ profiles, maxProfiles, profile });
      },
      updateProfile: (id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => {
        calls.push(`update ${id} ${JSON.stringify(body)}`);
        profiles = profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
        return ok({ profiles, maxProfiles, profile: profiles.find((p) => p.id === id)! });
      },
      deleteProfile: (id: string) => {
        calls.push(`delete ${id}`);
        if (profiles.length <= 1) return refuse("last_profile");
        profiles = profiles.filter((p) => p.id !== id).map((p, index) => ({ ...p, isMain: index === 0 }));
        return ok({ profiles, maxProfiles });
      },
    },
  };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** One store per bridge, as `Library` keeps one per window, so a re-render (the plan dialog closing) keeps it. */
const stores = new WeakMap<ParrotProfilesBridge, ProfileStore>();
const mount = async (bridge: ParrotProfilesBridge, planOpen = false) => {
  let store = stores.get(bridge);
  if (!store) {
    store = createParrotDesktopProfileStore(bridge);
    stores.set(bridge, store);
    await store.startSession({ userId: "u-1", token: "main", askEveryStart: false });
  }
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(<ProfilesSection store={store} language="en" planOpen={planOpen} />));
};

const q = <T extends Element>(selector: string) => container!.querySelector<T>(selector);
const avatarOf = (id: string) => q(`[data-testid="profile-row-${id}"] [data-testid="profile-avatar"]`)?.getAttribute("data-avatar") ?? null;
const rows = () => [...container!.querySelectorAll('[data-testid^="profile-row-"]')].map((row) => row.textContent ?? "");
const errorText = () => q('[data-testid="profiles-error"]')?.textContent ?? null;
const limitText = () => q('[data-testid="profile-add-limit"]')?.textContent ?? null;
const addDisabled = () => q<HTMLButtonElement>('[data-testid="profile-add"]')!.disabled;

const setInput = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const addProfile = async (name: string) => {
  await act(async () => q<HTMLButtonElement>('[data-testid="profile-add"]')!.click());
  const input = q<HTMLInputElement>('[data-testid="profile-name-input"]');
  if (!input) return;
  await act(async () => setInput(input, name));
  await act(async () => q<HTMLButtonElement>('[data-testid="profile-save"]')!.click());
};

const deleteProfile = async (id: string) => {
  await act(async () => q<HTMLButtonElement>(`[data-testid="profile-delete-${id}"]`)!.click());
  const confirm = q<HTMLButtonElement>('[data-testid="profile-delete-confirm"]');
  if (confirm) await act(async () => confirm.click());
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  localStorage.clear();
});

describe("Parrot desktop Settings ▸ Account ▸ Profiles", () => {
  /** @req ACCT-PROF-01[parrot] @req ACCT-PROF-02[parrot] */
  it("@req ACCT-PROF-01 @req ACCT-PROF-02 a paid account adds up to 5, a 6th is refused, and any profile deletes down to the last", async () => {
    const main = fakeMain("tier1");
    console.info(`${SUITE} phase: open on a paid account (limit 5)`);
    await mount(main.bridge);
    expect(container!.textContent).toContain(EN.settingsGroup);
    expect(rows()).toHaveLength(1);

    console.info(`${SUITE} phase: add up to 5`);
    for (const name of ["Mila", "Celeste", "Jonas", "Rosa"]) await addProfile(name);
    console.info(`${SUITE} rows: ${rows().join(" | ")}; calls: ${main.calls.join(", ")}`);
    expect(rows()).toHaveLength(5);
    expect(main.profiles().map((p) => p.name)).toEqual(["Chris", "Mila", "Celeste", "Jonas", "Rosa"]);
    expect(errorText()).toBeNull();

    console.info(`${SUITE} phase: a 6th is refused: Add profile greyed, the reason under it`);
    expect(addDisabled()).toBe(true);
    await addProfile("Bruno");
    console.info(`${SUITE} limit note: ${limitText()}`);
    expect(limitText()).toBe(EN.errors.limit.replace("{{max}}", "5"));
    expect(main.profiles()).toHaveLength(5);

    console.info(`${SUITE} phase: delete down to one, the main one included`);
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-delete-p-0"]')!.click());
    // Parrot says what a listening profile loses, not Badger's watch history.
    expect(q('[role="alertdialog"]')!.textContent).toContain(EN.deleteBodyListening);
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-delete-confirm"]')!.click());
    for (const id of ["p-1", "p-2", "p-3"]) await deleteProfile(id);
    console.info(`${SUITE} rows: ${rows().join(" | ")}; calls: ${main.calls.join(", ")}`);
    expect(main.profiles().map((p) => p.name)).toEqual(["Rosa"]);
    expect(rows()).toHaveLength(1);

    console.info(`${SUITE} phase: the last one can't be deleted`);
    await deleteProfile("p-4");
    console.info(`${SUITE} error: ${errorText()}`);
    expect(errorText()).toBe(EN.errors.last);
    expect(main.profiles().map((p) => p.name)).toEqual(["Rosa"]);
  });

  /** @req ACCT-PROF-01[parrot] */
  it("@req ACCT-PROF-01 a free account keeps one profile", async () => {
    const main = fakeMain("free");
    console.info(`${SUITE} phase: open on Free (limit ${MAX_PROFILES_FREE})`);
    await mount(main.bridge);
    await addProfile("Mila");
    console.info(`${SUITE} limit note: ${limitText()}; calls: ${main.calls.join(", ")}`);
    expect(addDisabled()).toBe(true);
    expect(limitText()).toBe(EN.limitFree.replace("{{paidMax}}", "5"));
    expect(main.profiles()).toHaveLength(1);
  });

  /** @req ACCT-PROF-01[parrot] */
  it("@req ACCT-PROF-01 the limit follows a plan bought in the dialog over Settings", async () => {
    const main = fakeMain("free");
    console.info(`${SUITE} phase: Free, plan dialog open`);
    await mount(main.bridge, true);
    main.upgrade();
    console.info(`${SUITE} phase: dialog closed on Starter`);
    await mount(main.bridge, false);
    await addProfile("Mila");
    console.info(`${SUITE} rows: ${rows().join(" | ")}; calls: ${main.calls.join(", ")}`);
    expect(errorText()).toBeNull();
    expect(limitText()).toBeNull();
    expect(main.profiles().map((p) => p.name)).toEqual(["Chris", "Mila"]);
  });

  /** @req ACCT-PROF-01[parrot] @req ACCT-PROF-05[parrot] */
  it("@req ACCT-PROF-01 @req ACCT-PROF-05 opening the page again shows profiles added and edited on the website", async () => {
    const main = fakeMain("tier1");
    await mount(main.bridge);
    expect(rows().join(" | ")).toContain("Chris");
    console.info(`${SUITE} phase: page closed; the website adds Rosa and renames Chris → Christopher/fox`);
    act(() => root?.unmount());
    root = null;
    main.addElsewhere("Rosa");
    await main.bridge.updateProfile("p-0", { name: "Christopher", avatarId: "fox" });
    await mount(main.bridge);
    await act(async () => {
      await setTimeout(0);
    });
    console.info(`${SUITE} rows after reopening: ${rows().join(" | ")}; calls: ${main.calls.join(", ")}`);
    expect(rows().some((row) => row.includes("Rosa"))).toBe(true);
    expect(rows().some((row) => row.includes("Christopher"))).toBe(true);
    expect(avatarOf("p-0")).toBe("fox");
  });

  /** @req ACCT-PROF-05[parrot] */
  it("@req ACCT-PROF-05 rows show each profile's avatar; Edit changes the name and the avatar through the chooser", async () => {
    const main = fakeMain("tier1");
    await mount(main.bridge);
    console.info(`${SUITE} phase: the list shows the stored avatar`);
    expect(avatarOf("p-0")).toBe("raccoon");

    console.info(`${SUITE} phase: edit p-0, pick the fox, rename`);
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-edit-p-0"]')!.click());
    expect(q('[data-testid="profile-edit"]')!.textContent).toContain(EN.editTitle);
    expect(q('[data-testid="profile-avatar-preview"]')!.getAttribute("data-avatar")).toBe("raccoon");
    expect(container!.querySelectorAll('[data-testid^="avatar-option-"]')).toHaveLength(22);
    await act(async () => q<HTMLButtonElement>('[data-testid="avatar-option-fox"]')!.click());
    expect(q('[data-testid="profile-avatar-preview"]')!.getAttribute("data-avatar")).toBe("fox");
    await act(async () => setInput(q<HTMLInputElement>('[data-testid="profile-name-input"]')!, "Christopher"));
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-save"]')!.click());
    console.info(`${SUITE} rows: ${rows().join(" | ")}; calls: ${main.calls.join(", ")}`);
    expect(main.calls).toContain('update p-0 {"name":"Christopher","avatarId":"fox"}');
    expect(q('[data-testid="profile-edit"]')).toBeNull();
    expect(avatarOf("p-0")).toBe("fox");
    expect(rows()[0]).toContain("Christopher");

    console.info(`${SUITE} phase: a new profile gets the avatar picked for it`);
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-add"]')!.click());
    await act(async () => q<HTMLButtonElement>('[data-testid="avatar-option-penguin"]')!.click());
    await act(async () => setInput(q<HTMLInputElement>('[data-testid="profile-name-input"]')!, "Mila"));
    await act(async () => q<HTMLButtonElement>('[data-testid="profile-save"]')!.click());
    console.info(`${SUITE} calls: ${main.calls.join(", ")}`);
    expect(main.calls).toContain("create Mila penguin");
    expect(avatarOf("p-1")).toBe("penguin");
  });

  /** @req ACCT-PROF-01[parrot] @req ACCT-PROF-02[parrot] */
  it("@req ACCT-PROF-01 @req ACCT-PROF-02 the server's refusals reach the window through main", async () => {
    const main = fakeMain("tier1");
    const store = createParrotDesktopProfileStore(main.bridge);
    await store.startSession({ userId: "u-2", token: "main", askEveryStart: false });
    for (const name of ["Mila", "Celeste", "Jonas"]) await store.createProfile(name);
    console.info(`${SUITE} phase: a 5th made on another device, then this window adds one more`);
    main.addElsewhere("Rosa");
    const refusedCreate = await store.createProfile("Bruno").catch((error: unknown) => error);
    console.info(`${SUITE} create refused with: ${(refusedCreate as ProfileActionError).code}`);
    expect(refusedCreate).toBeInstanceOf(ProfileActionError);
    expect((refusedCreate as ProfileActionError).code).toBe("profile_limit");
    expect(main.calls).toContain("create Bruno");

    console.info(`${SUITE} phase: main offline`);
    const offline = createParrotDesktopProfileStore({ ...fakeMain("tier1").bridge, createProfile: async () => ({ ok: false, offline: true }) });
    await offline.startSession({ userId: "u-3", token: "main", askEveryStart: false });
    const refusedOffline = await offline.createProfile("Dave").catch((error: unknown) => error);
    console.info(`${SUITE} offline create refused with: ${(refusedOffline as ProfileActionError).code}`);
    expect((refusedOffline as ProfileActionError).code).toBe("offline");
  });
});
