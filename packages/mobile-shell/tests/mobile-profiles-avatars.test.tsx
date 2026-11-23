/**
 * @test-id MOBILE-SHELL-PROFILE-AVATARS-001
 * @level component
 * @why Chris 2026-11-16 approved the avatar pack (ACCT-PROF-05): every profile shows one of 22 built-in avatars, the
 *   same on every app. The phone's "Who's watching?" (mockup `mockup-whos-watching.png`) draws each profile's avatar on
 *   a big tile with an "Add profile" tile and an outlined "Manage profiles"; Manage profiles lists each profile with its
 *   avatar and one Edit button (rename is gone); adding or editing opens the chooser (mockup
 *   `mockup-avatar-picker.png`): back arrow, "Choose an avatar", Save, the preview, the name, then the 22 in pack
 *   order, four across, the chosen one ticked. A new profile starts on the first avatar nobody uses, and Save sends the
 *   chosen id with the name. Rendered with react-test-renderer: react-native is replaced by host-element stand-ins and
 *   the profile store by an in-memory fake.
 *   The limits (Chris 2026-11-18, "I can't edit or add any new profiles"): a full account keeps "Add profile" in Manage
 *   profiles, greyed, with the reason under it (a free account says paid plans have up to 5); opening the screen
 *   re-reads the list so a profile added or edited in another app shows.
 */
// @req ACCT-PROF-05[badger-mobile] @req UX-PROF-01[badger-mobile] @req ACCT-PROF-01[badger-mobile]
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile } from "@space/shared/profiles";
import type { ProfileLibraryMoves, ProfileStore, ProfilesSnapshot } from "@space/shared/profileStore";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("lucide-react-native", () => ({ Check: "Check", ChevronLeft: "ChevronLeft", Plus: "Plus" }));
vi.mock("../src/components/mobile-button", () => ({ MobileButton: "MobileButton" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: {
      text: "#fff",
      textMuted: "#aaa",
      textDim: "#777",
      accent: "#ff8a00",
      danger: "#f55",
      border: "#333",
      surface: "#111",
      surfaceRaised: "#1b1b1b",
      background: "#000",
    },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    font: { family: { display: "Display" } },
    accentTextHex: "#000",
  }),
}));
// Keys come back as they are, with their values, so the test reads which text each element asks for.
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
// One number per picture, as Metro's require would give: the pack order plus one. vi.mock factories run before the
// file's imports, so the id list loads inside it.
vi.mock("@space/profile-avatars/native", async () => {
  const { PROFILE_AVATAR_IDS: ids } = await import("@space/shared/profileAvatars");
  return { PROFILE_AVATAR_SOURCES: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
});

import { MobileProfilesScreen } from "../src/profiles/MobileProfilesScreen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAG = "[MOBILE-SHELL-PROFILE-AVATARS-001]";
const sourceOf = (id: ProfileAvatarId) => PROFILE_AVATAR_IDS.indexOf(id) + 1;

const profile = (id: string, name: string, avatarId: ProfileAvatarId, avatar = 0): ApiProfile => ({
  id,
  name,
  avatar,
  avatarId,
  createdAt: `2026-11-1${id.length}T00:00:00.000Z`,
  isMain: id === "p-main",
});

/**
 * The store the screen talks to: the list, and the calls the chooser's Save and Delete make. With `calls.compilerCache`
 * set, `canCreate()` keeps its first answer, as the React Compiler caches a call on the store (which never changes) made
 * in render: Add must follow the snapshot, not that answer.
 */
const fakeStore = (profiles: ApiProfile[], maxProfiles = 5) => {
  let snapshot: ProfilesSnapshot = { userId: "u-1", profiles, maxProfiles, activeId: null, needsChoice: true, status: "ready", stale: false };
  const listeners = new Set<() => void>();
  const publish = (next: ApiProfile[]) => {
    snapshot = { ...snapshot, profiles: next };
    listeners.forEach((listener) => listener());
  };
  const calls = {
    created: [] as Array<{ name: string; avatarId?: ProfileAvatarId }>,
    edited: [] as Array<{ id: string; change: { name?: string; avatarId?: ProfileAvatarId } }>,
    refreshes: 0,
    compilerCache: false,
    cachedCanCreate: null as boolean | null,
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    canCreate: () => {
      const now = snapshot.profiles.length < snapshot.maxProfiles;
      if (!calls.compilerCache) return now;
      calls.cachedCanCreate ??= now;
      return calls.cachedCanCreate;
    },
    selectProfile: async () => undefined,
    deleteProfile: async (id: string) => {
      publish(snapshot.profiles.filter((p) => p.id !== id));
    },
    refresh: async () => {
      calls.refreshes += 1;
    },
    createProfile: async (name: string, avatarId?: ProfileAvatarId) => {
      calls.created.push({ name, avatarId });
      const made = profile(`p-${snapshot.profiles.length}`, name, avatarId ?? "badger");
      publish([...snapshot.profiles, made]);
      return made;
    },
    editProfile: async (id: string, change: { name?: string; avatarId?: ProfileAvatarId }) => {
      calls.edited.push({ id, change });
      const next = snapshot.profiles.map((p) => (p.id === id ? { ...p, ...change } : p));
      publish(next);
      return next.find((p) => p.id === id)!;
    },
  };
  return { store: store as unknown as ProfileStore, calls };
};

const moves = {} as ProfileLibraryMoves;

const render = (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
};
const byTestId = (renderer: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
/** The avatar picture inside a tile or a row (the host Image, not its `ProfileAvatarImage` wrapper). */
const avatarIn = (node: ReactTestInstance) => node.findAll((child) => child.props.testID === "profile-avatar" && typeof child.type === "string")[0]!;
const one = (renderer: ReactTestRenderer, testID: string) => {
  const found = byTestId(renderer, testID);
  expect(found, `${testID} is on screen once`).toHaveLength(1);
  return found[0]!;
};
const press = async (renderer: ReactTestRenderer, testID: string) => {
  console.info(TAG, "press", testID);
  await act(async () => {
    one(renderer, testID).props.onPress();
  });
};
/** The chooser draws its cells once it knows its width (four across in a 360-wide column). */
const layOutChooser = (renderer: ReactTestRenderer) =>
  act(() => {
    one(renderer, "avatar-chooser").props.onLayout({ nativeEvent: { layout: { width: 360, height: 0 } } });
  });
const selectedOptions = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => typeof node.type === "string" && String(node.props.testID ?? "").startsWith("avatar-option-") && node.props.accessibilityRole === "radio")
    .filter((node) => node.props.accessibilityState?.selected)
    .map((node) => String(node.props.testID).replace("avatar-option-", ""));

const screen = (store: ProfileStore, startMode: "pick" | "manage", events: string[]) =>
  render(
    <MobileProfilesScreen
      store={store}
      moves={moves}
      startMode={startMode}
      audience="watching"
      onClose={null}
      log={(event, data) => {
        events.push(event);
        console.info(TAG, "flow", event, JSON.stringify(data));
      }}
    />,
  );

describe("MobileProfilesScreen avatars (ACCT-PROF-05)", () => {
  it("\"Who's watching?\" shows each profile's avatar on its tile, an Add profile tile and Manage profiles", () => {
    console.info(TAG, "phase: who's watching with a pack avatar and an old colour-only profile");
    // `avatarId` null is a row from before the pack: its colour (7, pink) reads as the bunny.
    const { store } = fakeStore([profile("p-main", "Chris", "owl"), { ...profile("p-kids", "Kids", "badger", 7), avatarId: null as unknown as ProfileAvatarId }]);
    const renderer = screen(store, "pick", []);
    const tile0 = one(renderer, "profile-tile-0");
    const tile1 = one(renderer, "profile-tile-1");
    console.info(TAG, "tile sources", avatarIn(tile0).props.source, avatarIn(tile1).props.source);
    expect(avatarIn(tile0).props.source).toBe(sourceOf("owl"));
    expect(avatarIn(tile1).props.source).toBe(sourceOf("bunny"));
    expect(avatarIn(tile0).props.style[0]).toMatchObject({ width: 104, height: 104 });
    expect(tile0.props.accessibilityLabel).toBe("Chris");
    expect(one(renderer, "profile-add-tile").props.accessibilityLabel).toBe("profiles.add");
    expect(one(renderer, "profiles-manage")).toBeDefined();
  });

  it("Manage profiles has one Edit per profile and no rename", async () => {
    console.info(TAG, "phase: manage rows");
    const { store } = fakeStore([profile("p-main", "Chris", "badger"), profile("p-two", "Sam", "fox")]);
    const renderer = screen(store, "manage", []);
    const row1 = one(renderer, "profile-row-1");
    expect(avatarIn(row1).props.source).toBe(sourceOf("fox"));
    expect(one(renderer, "profile-edit-1").props.accessibilityLabel).toBe('profiles.editA11y {"name":"Sam"}');
    const ids = renderer.root.findAll((node) => typeof node.props.testID === "string").map((node) => String(node.props.testID));
    console.info(TAG, "manage test ids", JSON.stringify(ids));
    expect(ids.some((id) => id.includes("rename"))).toBe(false);
  });

  it("Add opens the chooser on the first unused avatar, and Save creates the profile with the one picked", async () => {
    const events: string[] = [];
    const { store, calls } = fakeStore([profile("p-main", "Chris", "badger")]);
    const renderer = screen(store, "pick", events);

    console.info(TAG, "phase: add tile -> chooser");
    await press(renderer, "profile-add-tile");
    one(renderer, "profile-edit");
    expect(one(renderer, "profile-edit").findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header")[0]!.props.children).toBe("profiles.chooseAvatar");
    layOutChooser(renderer);
    const options = renderer.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "radio");
    console.info(TAG, "options", options.length, "selected", selectedOptions(renderer));
    expect(options.map((node) => String(node.props.testID).replace("avatar-option-", ""))).toEqual([...PROFILE_AVATAR_IDS]);
    // Four across a 360 column with 16 gaps: (360 - 48) / 4.
    expect(options[0]!.props.style[1]).toMatchObject({ width: 78, height: 78 });
    expect(options[3]!.props.accessibilityLabel).toBe("profiles.avatars.cat");
    // The badger is taken by the main profile: the new one starts on the parrot, ticked, and the preview shows it.
    expect(selectedOptions(renderer)).toEqual(["parrot"]);
    expect(byTestId(renderer, "avatar-option-tick")).toHaveLength(1);
    expect(one(renderer, "profile-avatar-preview").props.source).toBe(sourceOf("parrot"));
    expect(one(renderer, "profile-save").props.disabled).toBe(true);

    console.info(TAG, "phase: type a name, pick the robot, Save");
    act(() => one(renderer, "profile-name-input").props.onChangeText("Sam"));
    await press(renderer, "avatar-option-robot");
    expect(selectedOptions(renderer)).toEqual(["robot"]);
    expect(one(renderer, "profile-avatar-preview").props.source).toBe(sourceOf("robot"));
    await press(renderer, "profile-save");
    console.info(TAG, "created", JSON.stringify(calls.created), "events", events.join(","));
    expect(calls.created).toEqual([{ name: "Sam", avatarId: "robot" }]);
    expect(events).toEqual(expect.arrayContaining(["add.start", "avatar.chosen", "created"]));
    const tile1 = one(renderer, "profile-tile-1");
    expect(avatarIn(tile1).props.source).toBe(sourceOf("robot"));
  });

  it("Edit opens the chooser on the profile's avatar and name, and Save sends both", async () => {
    const events: string[] = [];
    const { store, calls } = fakeStore([profile("p-main", "Chris", "badger"), profile("p-two", "Sam", "fox")]);
    const renderer = screen(store, "manage", events);

    console.info(TAG, "phase: edit row 1");
    await press(renderer, "profile-edit-1");
    expect(one(renderer, "profile-edit").props.accessibilityLabel).toBe("profiles.editTitle");
    expect(one(renderer, "profile-name-input").props.value).toBe("Sam");
    layOutChooser(renderer);
    expect(selectedOptions(renderer)).toEqual(["fox"]);

    console.info(TAG, "phase: rename to Samuel, pick the whale, Save");
    act(() => one(renderer, "profile-name-input").props.onChangeText("Samuel"));
    await press(renderer, "avatar-option-whale");
    await press(renderer, "profile-save");
    console.info(TAG, "edited", JSON.stringify(calls.edited), "events", events.join(","));
    expect(calls.edited).toEqual([{ id: "p-two", change: { name: "Samuel", avatarId: "whale" } }]);
    expect(events).toContain("edited");
    // Back on Manage profiles with the new avatar.
    expect(avatarIn(one(renderer, "profile-row-1")).props.source).toBe(sourceOf("whale"));
  });

  it("the back arrow leaves the chooser without saving", async () => {
    const { store, calls } = fakeStore([profile("p-main", "Chris", "badger"), profile("p-two", "Sam", "fox")]);
    const renderer = screen(store, "manage", []);
    await press(renderer, "profile-edit-0");
    layOutChooser(renderer);
    await press(renderer, "avatar-option-moon");
    await press(renderer, "profile-cancel");
    console.info(TAG, "after back", JSON.stringify(calls));
    expect(calls.edited).toEqual([]);
    expect(byTestId(renderer, "profile-edit")).toHaveLength(0);
    one(renderer, "profile-row-0");
  });
});

describe("MobileProfilesScreen limits (ACCT-PROF-01)", () => {
  it("a free account's Manage profiles keeps Add profile greyed and says a free account has one, paid plans up to 5", () => {
    const { store } = fakeStore([profile("p-main", "Chris", "badger")], 1);
    const renderer = screen(store, "manage", []);
    const note = one(renderer, "profile-add-limit");
    console.info(TAG, "free: add disabled", one(renderer, "profile-add").props.disabled, "note", note.props.children);
    expect(one(renderer, "profile-add").props.disabled).toBe(true);
    expect(note.props.children).toBe('profiles.limitFree {"paidMax":5}');
  });

  it("a full paid account says it has its 5 profiles; one with room shows Add enabled and no note", () => {
    const five = (["badger", "fox", "cat", "owl", "dino"] as const).map((avatar, index) => profile(index === 0 ? "p-main" : `p-${index}`, `P${index}`, avatar));
    const full = screen(fakeStore(five, 5).store, "manage", []);
    expect(one(full, "profile-add").props.disabled).toBe(true);
    expect(one(full, "profile-add-limit").props.children).toBe('profiles.errors.limit {"max":5}');
    const room = screen(fakeStore([profile("p-main", "Chris", "badger")], 5).store, "manage", []);
    expect(one(room, "profile-add").props.disabled).toBe(false);
    expect(byTestId(room, "profile-add-limit")).toHaveLength(0);
  });

  it("opening the screen re-reads the profile list once", () => {
    const { store, calls } = fakeStore([profile("p-main", "Chris", "badger")], 5);
    screen(store, "pick", []);
    console.info(TAG, "refreshes on open", calls.refreshes);
    expect(calls.refreshes).toBe(1);
  });
});

describe("MobileProfilesScreen limits without a remount (ACCT-PROF-01)", () => {
  it("adding the 5th profile greys Add with the note at once, and deleting one brings Add back", async () => {
    const four = (["badger", "fox", "cat", "owl"] as const).map((avatar, index) => profile(index === 0 ? "p-main" : `p-${index}`, `P${index}`, avatar));
    const { store, calls } = fakeStore(four, 5);
    const renderer = screen(store, "manage", []);
    calls.compilerCache = true;
    expect(one(renderer, "profile-add").props.disabled).toBe(false);

    console.info(TAG, "phase: add the 5th from Manage profiles");
    await press(renderer, "profile-add");
    act(() => one(renderer, "profile-name-input").props.onChangeText("Robin"));
    await press(renderer, "profile-save");
    console.info(TAG, "after add: disabled", one(renderer, "profile-add").props.disabled);
    expect(calls.created).toHaveLength(1);
    expect(one(renderer, "profile-add").props.disabled).toBe(true);
    expect(one(renderer, "profile-add-limit").props.children).toBe('profiles.errors.limit {"max":5}');

    console.info(TAG, "phase: delete the 5th");
    await press(renderer, "profile-delete-4");
    await press(renderer, "profile-delete-confirm");
    console.info(TAG, "after delete: disabled", one(renderer, "profile-add").props.disabled);
    expect(one(renderer, "profile-add").props.disabled).toBe(false);
    expect(byTestId(renderer, "profile-add-limit")).toHaveLength(0);
  });
});

describe("MobileProfilesScreen long labels (UX-PROF-01)", () => {
  it("the chooser title sits on its own line under back and Save, and each Manage name has its own line above Edit and Delete", async () => {
    const { store } = fakeStore([profile("p-main", "Grégoire-Alexandre", "badger"), profile("p-2", "Kids", "fox")], 5);
    const renderer = screen(store, "manage", []);
    const name = byTestId(renderer, "profile-row-0")[0]!.findAll((node) => String(node.type) === "Text" && node.props.children === "Grégoire-Alexandre")[0]!;
    const nameLine = name.parent!;
    console.info(TAG, "name line holds edit", nameLine.findAll((node) => node.props.testID === "profile-edit-0").length);
    // The name's direct row is not the one holding the buttons: they sit on a line of their own under it.
    expect(nameLine.children.filter((child) => typeof child !== "string" && child.props.testID === "profile-edit-0")).toHaveLength(0);
    expect(name.props.numberOfLines).toBe(1);

    await press(renderer, "profile-edit-0");
    const title = one(renderer, "profile-edit").findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header")[0]!;
    const titleRow = title.parent!;
    console.info(TAG, "title row holds save", titleRow.findAll((node) => node.props.testID === "profile-save").length);
    expect(titleRow.props.testID).toBe("profile-edit");
    expect(title.props.numberOfLines).toBeUndefined();
  });
});
