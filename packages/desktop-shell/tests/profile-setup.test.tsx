// @vitest-environment jsdom
/**
 * @req UX-SETUP-10[badger-desktop,parrot,badger-web-player,parrot-web-player]
 * @req UX-UPDATE-01[badger-desktop,parrot,badger-web-player,parrot-web-player]
 * @req UX-SETUP-08[badger-desktop,parrot]
 * @test-id DESKTOP-SHELL-PROFILE-SETUP-001..008
 * @level unit
 * @why "Your profile" and "New in this update" are one shared step and one shared window on the four computer and
 *   browser apps. The step is owed only by a profile made since the avatars that has not answered it; Next always
 *   saves the name, the avatar and `features.avatars = "set"`, even when nothing changed. The window shows only to a
 *   profile from before the avatars; Later saves "later" so it never comes back; its button opens the same step.
 */
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { createProfileStore } from "@space/shared/profileStore";
import { profilesTranslator } from "@space/shared/profileTexts";
import { ProfileSetupStep, saveProfileSetup } from "../src/components/profile-setup";
import { UpdateFeaturesHost, needsProfileSetupStep, pendingUpdateWindows } from "../src/components/update-features";

const LOG = "[profile-setup.test]";
const log = (event: string, data: Record<string, unknown>) => console.info(LOG, event, JSON.stringify(data));
const t = profilesTranslator("en");

const BEFORE_AVATARS = "2026-11-01T00:00:00.000Z";
const SINCE_AVATARS = "2026-11-20T00:00:00.000Z";

const profile = (id: string, name: string, createdAt: string, features: ApiProfile["features"] = {}): ApiProfile =>
  ({ id, name, avatar: 5, avatarId: "badger", createdAt, isMain: id === "p1", features }) as ApiProfile;

const setup = async (initial: ApiProfile[]) => {
  let profiles = initial;
  const updates: Record<string, unknown>[] = [];
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
      create: async () => {
        throw new Error("not in these tests");
      },
      update: async (_token, id, body) => {
        updates.push({ id, ...body });
        log("api.update", { id, body });
        profiles = profiles.map((entry) =>
          entry.id === id ? { ...entry, ...body, features: { ...entry.features, ...(body.features ?? {}) } } : entry
        );
        return { ...response(), profile: profiles.find((entry) => entry.id === id)! };
      },
      remove: async () => response(),
    },
    applyScope: () => undefined,
    log,
  });
  await store.startSession({ userId: "u1", token: "t", askEveryStart: false });
  await store.refresh();
  return { store, updates, current: (id: string) => store.getSnapshot().profiles.find((entry) => entry.id === id)! };
};

const screenProps = { t, log, backLabel: "Back", nextLabel: "Next", mascotSrc: null, mascotAlt: "" };

afterEach(cleanup);

describe("Your profile and New in this update (UX-SETUP-10, UX-UPDATE-01)", () => {
  it("DESKTOP-SHELL-PROFILE-SETUP-001: the step is owed only by a profile made since the avatars that has not answered it", () => {
    const cases = {
      newProfile: needsProfileSetupStep(profile("p1", "Chris", SINCE_AVATARS)),
      newAnswered: needsProfileSetupStep(profile("p1", "Chris", SINCE_AVATARS, { avatars: "set" })),
      oldProfile: needsProfileSetupStep(profile("p1", "Chris", BEFORE_AVATARS)),
      none: needsProfileSetupStep(null),
    };
    console.info(`${LOG}:001`, JSON.stringify(cases));
    expect(cases).toEqual({ newProfile: true, newAnswered: false, oldProfile: false, none: false });
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-002: the window is owed only by a profile from before the avatars that has not answered it", () => {
    const ids = (entry: ApiProfile) => pendingUpdateWindows(entry).map((feature) => feature.id);
    const cases = {
      oldProfile: ids(profile("p1", "Chris", BEFORE_AVATARS)),
      oldLater: ids(profile("p1", "Chris", BEFORE_AVATARS, { avatars: "later" })),
      oldSet: ids(profile("p1", "Chris", BEFORE_AVATARS, { avatars: "set" })),
      newProfile: ids(profile("p1", "Chris", SINCE_AVATARS)),
    };
    console.info(`${LOG}:002`, JSON.stringify(cases));
    expect(cases).toEqual({ oldProfile: ["avatars"], oldLater: [], oldSet: [], newProfile: [] });
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-003: Next saves the name, the avatar and avatars=set even when nothing changed", async () => {
    const { store, updates, current } = await setup([profile("p1", "Chris", SINCE_AVATARS)]);
    render(<ProfileSetupStep {...screenProps} profile={current("p1")} onNext={(answer) => saveProfileSetup(store, "p1", answer)} />);
    expect((screen.getByTestId("profile-setup-name") as HTMLInputElement).value).toBe("Chris");
    // Main 2026-11-19 (Chris: "drop duplicate/useless back"): alone, no Back at all, Next alone in the footer.
    expect(screen.queryByTestId("profile-setup-back"), "shown alone: no Back").toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("profile-setup-next")));
    console.info(`${LOG}:003 updates=${JSON.stringify(updates)}`);
    expect(updates).toEqual([{ id: "p1", name: "Chris", avatarId: "badger", features: { avatars: "set" } }]);
    expect(needsProfileSetupStep(current("p1")), "answered: not owed any more").toBe(false);
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-004: the round chooser picks a new avatar, the preview follows it, and Next saves the typed name", async () => {
    const { store, updates, current } = await setup([profile("p1", "Chris", SINCE_AVATARS)]);
    render(<ProfileSetupStep {...screenProps} profile={current("p1")} onNext={(answer) => saveProfileSetup(store, "p1", answer)} />);
    expect(screen.getByTestId("avatar-chooser").getAttribute("data-variant")).toBe("round");
    fireEvent.click(screen.getByTestId("avatar-option-owl"));
    expect(screen.getByTestId("profile-setup-preview").querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("owl");
    fireEvent.change(screen.getByTestId("profile-setup-name"), { target: { value: "  Christophe " } });
    await act(async () => fireEvent.click(screen.getByTestId("profile-setup-next")));
    console.info(`${LOG}:004 updates=${JSON.stringify(updates)}`);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: "p1", avatarId: "owl", features: { avatars: "set" } });
    expect(current("p1").name.trim()).toBe("Christophe");
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-005: an empty name greys Next out and saves nothing", async () => {
    const { store, updates, current } = await setup([profile("p1", "Chris", SINCE_AVATARS)]);
    render(<ProfileSetupStep {...screenProps} profile={current("p1")} onNext={(answer) => saveProfileSetup(store, "p1", answer)} />);
    fireEvent.change(screen.getByTestId("profile-setup-name"), { target: { value: "   " } });
    expect(screen.getByTestId("profile-setup-next").hasAttribute("disabled")).toBe(true);
    console.info(`${LOG}:005 updates=${updates.length}`);
    expect(updates).toHaveLength(0);
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-006: the window shows only to a profile from before; Later saves later and it does not come back", async () => {
    const { store, updates, current } = await setup([profile("p1", "Chris", BEFORE_AVATARS), profile("p2", "Marie", SINCE_AVATARS)]);
    const frame = (content: ReactNode) => <main>{content}</main>;
    const view = render(<UpdateFeaturesHost {...screenProps} store={store} profile={current("p2")} frame={frame} />);
    expect(screen.queryByTestId("whats-new-window"), "a profile made since the avatars sees no window").toBeNull();

    view.rerender(<UpdateFeaturesHost {...screenProps} store={store} profile={current("p1")} frame={frame} />);
    const whatsNew = screen.getByTestId("whats-new-window");
    console.info(`${LOG}:006 window=${whatsNew.textContent}`);
    expect(whatsNew.getAttribute("data-feature")).toBe("avatars");
    expect(screen.getByTestId("whats-new-name").textContent).toBe("Chris");
    await act(async () => fireEvent.click(screen.getByTestId("whats-new-later")));
    expect(updates).toEqual([{ id: "p1", features: { avatars: "later" } }]);
    expect(screen.queryByTestId("whats-new-window"), "hidden at once").toBeNull();

    // The next start: a fresh host for the saved profile shows nothing.
    cleanup();
    render(<UpdateFeaturesHost {...screenProps} store={store} profile={current("p1")} frame={frame} />);
    console.info(`${LOG}:006 features=${JSON.stringify(current("p1").features)}`);
    expect(screen.queryByTestId("whats-new-window")).toBeNull();
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-007: Choose my avatar opens the same step; Back returns to the window and Next saves set", async () => {
    const { store, updates, current } = await setup([profile("p1", "Chris", BEFORE_AVATARS)]);
    const frame = (content: ReactNode) => <main>{content}</main>;
    const view = render(<UpdateFeaturesHost {...screenProps} store={store} profile={current("p1")} frame={frame} />);
    fireEvent.click(screen.getByTestId("whats-new-cta"));
    expect(screen.getByTestId("whats-new-screen").getAttribute("data-feature")).toBe("avatars");
    expect(screen.getByTestId("profile-setup-step")).toBeTruthy();
    expect(screen.queryByTestId("setup-step-bar"), "shown from the window: no step count").toBeNull();
    fireEvent.click(screen.getByTestId("profile-setup-back"));
    expect(screen.getByTestId("whats-new-window")).toBeTruthy();
    fireEvent.click(screen.getByTestId("whats-new-cta"));
    await act(async () => fireEvent.click(screen.getByTestId("profile-setup-next")));
    console.info(`${LOG}:007 updates=${JSON.stringify(updates)}`);
    expect(updates).toEqual([{ id: "p1", name: "Chris", avatarId: "badger", features: { avatars: "set" } }]);
    view.rerender(<UpdateFeaturesHost {...screenProps} store={store} profile={current("p1")} frame={frame} />);
    expect(screen.queryByTestId("whats-new-window")).toBeNull();
    expect(screen.queryByTestId("whats-new-screen")).toBeNull();
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-008: the step's only Back is the bottom one beside Next, no Back link at the top", async () => {
    const { current } = await setup([profile("p1", "Chris", SINCE_AVATARS)]);
    render(<ProfileSetupStep {...screenProps} profile={current("p1")} onBack={() => undefined} onNext={async () => undefined} />);
    const backs = screen.getAllByRole("button", { name: "Back" });
    const links = screen.queryAllByRole("link", { name: /back/i });
    console.info(`${LOG}:008 backButtons=${backs.length} backLinks=${links.length}`);
    expect(backs).toHaveLength(1);
    expect(links).toHaveLength(0);
    expect(backs[0]!.parentElement, "Back sits beside Next").toBe(screen.getByTestId("profile-setup-next").parentElement);
  });

  it("DESKTOP-SHELL-PROFILE-SETUP-009: a numbered step with nowhere to go keeps Back greyed; alone, Next is the footer's only button", async () => {
    const { current } = await setup([profile("p1", "Chris", SINCE_AVATARS)]);
    const progress = { current: 2, total: 3, label: "Step 2 of 3", testId: "setup-progress" };
    const view = render(<ProfileSetupStep {...screenProps} profile={current("p1")} progress={progress} onNext={async () => undefined} />);
    expect(screen.getByTestId("profile-setup-back").hasAttribute("disabled"), "numbered: Back greyed").toBe(true);
    view.rerender(<ProfileSetupStep {...screenProps} profile={current("p1")} onNext={async () => undefined} />);
    const footer = screen.getByTestId("profile-setup-next").parentElement!;
    console.info(`${LOG}:009 aloneFooterButtons=${footer.querySelectorAll("button").length}`);
    expect(screen.queryByTestId("profile-setup-back")).toBeNull();
    expect(footer.querySelectorAll("button")).toHaveLength(1);
  });
});
