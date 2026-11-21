/**
 * @test-id TV-PROFILE-AVATARS-001
 * @level component
 * @why Chris 2026-11-16 approved the avatar pack (ACCT-PROF-05): every profile shows one of 22 built-in avatars, the
 *   same on every app. On the TV "Who's watching?" (mockup `mockup-whos-watching.png`) draws each profile's avatar on a
 *   big rounded tile (about 240 px on a 1080p TV); the focused tile gets a white ring and a bold name; an "Add profile"
 *   tile with a + and an outlined "Manage profiles" follow. Manage profiles has one Edit per profile (rename is gone),
 *   and adding or editing shows the 22 avatars in two rows of 11 that the remote walks, the chosen one ticked; Save sends
 *   the chosen id. Rendered with react-test-renderer at 1920x1080: react-native is replaced by host-element stand-ins
 *   and the app's profile store by an in-memory fake.
 *
 * @req ACCT-PROF-05[badger-tv]
 * @req UX-PROF-01[badger-tv]
 * @req ACCT-PROF-01[badger-tv]
 * @req ACCT-PROF-02[badger-tv]
 * @req UX-SETUP-10[badger-tv]
 *
 * A profile added on the TV had its avatar picked in the form, so it is created with `features.avatars = "set"` and
 * never sees "Your profile" (UX-SETUP-10).
 *
 * The limits (Chris 2026-11-18, "I can't edit or add any new profiles"): a full account keeps "Add profile" in Manage
 * profiles, greyed, with the reason under it (a free account says paid plans have up to 5); the last profile cannot be
 * deleted; opening the screen re-reads the list so a profile added or edited on the website shows. With the React
 * Compiler on, a `profileStore.canCreate()` call in render is cached for the screen's life (the store never changes),
 * so the fake store can answer `canCreate()` from its first call and Add must still follow each add and delete.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ProfileFeatures } from "@space/shared/appFeatures";
import type { ApiProfile } from "@space/shared/profiles";
import type { ProfilesSnapshot } from "@space/shared/profileStore";

const TAG = "[TV-PROFILE-AVATARS-001]";

const ctl = vi.hoisted(() => ({
  route: { name: "Profiles", params: { mode: "pick" } as { mode?: "pick" | "manage" } },
  snapshot: null as unknown as ProfilesSnapshot,
  listeners: new Set<() => void>(),
  created: [] as Array<{ name: string; avatarId?: string; features?: ProfileFeatures }>,
  edited: [] as Array<{ id: string; change: Record<string, unknown> }>,
  refreshes: 0,
  /** Set: `canCreate()` keeps its first answer, as the React Compiler's cache of a call on the unchanging store. */
  compilerCache: false,
  cachedCanCreate: null as boolean | null,
  /** testIDs of the native views asked for the remote's focus (`requestTVFocus`), in order. */
  focusRequests: [] as string[],
}));

vi.mock("react-native", async () => ({
  ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { isTV: true, OS: "android", constants: {}, select: (choices: Record<string, unknown>) => choices.android ?? choices.default },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  useWindowDimensions: () => ({ width: 1920, height: 1080, scale: 1, fontScale: 1 }),
}));
// vi.mock factories run before the file's imports, so the shared stand-ins load inside them.
vi.mock("lucide-react-native", async () => ({ ...(await import("../../../tests/setup/lucideMock")).lucideStandIns(), Plus: "PlusIcon" }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => undefined, navigate: () => undefined }),
  useRoute: () => ctl.route,
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: "en" },
  }),
}));
// One number per picture, as Metro's require would give: the pack order plus one.
vi.mock("@space/profile-avatars/native", async () => {
  const { PROFILE_AVATAR_IDS: ids } = await import("@space/shared/profileAvatars");
  return { PROFILE_AVATAR_SOURCES: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
});
vi.mock("../../store/library", () => ({ useLibraryActions: () => ({ profileMoves: {} }) }));
vi.mock("../../lib/profiles/profileStore", () => {
  const publish = (profiles: ApiProfile[]) => {
    ctl.snapshot = { ...ctl.snapshot, profiles };
    ctl.listeners.forEach((listener) => listener());
  };
  return {
    profileStore: {
      subscribe: (listener: () => void) => {
        ctl.listeners.add(listener);
        return () => ctl.listeners.delete(listener);
      },
      getSnapshot: () => ctl.snapshot,
      canCreate: () => {
        const now = ctl.snapshot.profiles.length < ctl.snapshot.maxProfiles;
        if (!ctl.compilerCache) return now;
        ctl.cachedCanCreate ??= now;
        return ctl.cachedCanCreate;
      },
      refresh: async () => {
        ctl.refreshes += 1;
      },
      selectProfile: async () => undefined,
      deleteProfile: async (id: string) => {
        publish(ctl.snapshot.profiles.filter((p) => p.id !== id));
      },
      createProfile: async (name: string, avatarId?: ProfileAvatarId, features?: ProfileFeatures) => {
        ctl.created.push({ name, avatarId, features });
        const made: ApiProfile = { id: `p-${ctl.snapshot.profiles.length}`, name, avatar: 0, avatarId: avatarId ?? "badger", createdAt: "2026-11-16T00:00:00.000Z", isMain: false, features: features ?? {} };
        publish([...ctl.snapshot.profiles, made]);
        return made;
      },
      editProfile: async (id: string, change: { name?: string; avatarId?: ProfileAvatarId }) => {
        ctl.edited.push({ id, change });
        publish(ctl.snapshot.profiles.map((p) => (p.id === id ? { ...p, ...change } : p)));
        return ctl.snapshot.profiles.find((p) => p.id === id)!;
      },
    },
  };
});

import { TV_AVATAR_COLUMNS, TV_TILE_AVATAR } from "@space/mobile-shell/tv/TvProfiles";
import { TvProfilesScreen } from "./TvProfilesScreen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sourceOf = (id: ProfileAvatarId) => PROFILE_AVATAR_IDS.indexOf(id) + 1;
const profile = (id: string, name: string, avatarId: ProfileAvatarId, isMain = false): ApiProfile => ({
  id,
  name,
  avatar: 0,
  avatarId,
  createdAt: "2026-11-01T00:00:00.000Z",
  isMain,
  features: {},
});

const start = (profiles: ApiProfile[], mode: "pick" | "manage", maxProfiles = 5) => {
  ctl.snapshot = { userId: "u-1", profiles, maxProfiles, activeId: null, needsChoice: true, status: "ready", stale: false };
  ctl.refreshes = 0;
  ctl.compilerCache = false;
  ctl.cachedCanCreate = null;
  ctl.listeners.clear();
  ctl.created.length = 0;
  ctl.edited.length = 0;
  ctl.focusRequests.length = 0;
  ctl.route = { name: "Profiles", params: { mode } };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TvProfilesScreen />, {
      createNodeMock: (element) => ({
        focus: () => undefined,
        requestTVFocus: () => {
          const props: unknown = element.props;
          ctl.focusRequests.push(props && typeof props === "object" && "testID" in props && typeof props.testID === "string" ? props.testID : "?");
        },
      }),
    });
  });
  return renderer;
};

const byTestId = (renderer: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (renderer: ReactTestRenderer, testID: string) => {
  const found = byTestId(renderer, testID);
  expect(found, `${testID} is on screen once`).toHaveLength(1);
  return found[0]!;
};
const press = async (renderer: ReactTestRenderer, testID: string) => {
  console.info(TAG, "select", testID);
  await act(async () => {
    one(renderer, testID).props.onPress();
  });
};
const avatarIn = (node: ReactTestInstance) => node.findAll((child) => child.props.testID === "profile-avatar" && typeof child.type === "string")[0]!;
/** Every style object a node draws with (arrays and the TV focus callback flattened, the callback read unfocused). */
const flatStyle = (style: unknown): Record<string, unknown> => {
  const resolved = typeof style === "function" ? style({ focused: false, pressed: false }) : style;
  if (Array.isArray(resolved)) return Object.assign({}, ...resolved.map(flatStyle));
  return resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
};
const selectedOptions = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "radio" && node.props.accessibilityState?.selected)
    .map((node) => String(node.props.testID).replace("avatar-option-", ""));

describe("TvProfilesScreen avatars (ACCT-PROF-05)", () => {
  it("\"Who's watching?\" shows each avatar on a big tile; the focused one is ringed in white with a bold name", () => {
    console.info(TAG, "phase: two profiles at 1080p");
    const renderer = start([profile("p-main", "Chris", "badger", true), profile("p-kids", "Kids", "dino")], "pick");
    const tile0 = one(renderer, "profile-tile-0");
    const tile1 = one(renderer, "profile-tile-1");
    console.info(TAG, "tile sources", avatarIn(tile0).props.source, avatarIn(tile1).props.source, "size", JSON.stringify(avatarIn(tile0).props.style[0]));
    expect(avatarIn(tile0).props.source).toBe(sourceOf("badger"));
    expect(avatarIn(tile1).props.source).toBe(sourceOf("dino"));
    // 120 design dp at twice the 960x540 design screen: 240 px tiles, as the mockup.
    expect(TV_TILE_AVATAR * 2).toBe(240);
    expect(avatarIn(tile0).props.style[0]).toMatchObject({ width: 240, height: 240 });
    one(renderer, "profile-add-tile");
    one(renderer, "profiles-manage");

    console.info(TAG, "phase: focus moves to Kids");
    const nameOf = (tile: ReactTestInstance) => flatStyle(tile.findAll((node) => (node.type as unknown) === "Text")[0]!.props.style);
    // The frame is the View right around the avatar (the image's parent is its ProfileAvatarImage component).
    const frameOf = (tile: ReactTestInstance) => {
      let node = avatarIn(tile).parent;
      while (node && (node.type as unknown) !== "View") node = node.parent;
      return flatStyle(node?.props.style);
    };
    const before = { name: nameOf(tile1).fontWeight, ring: frameOf(tile1).borderColor };
    act(() => one(renderer, "profile-tile-1").props.onFocus());
    const focusedTile = one(renderer, "profile-tile-1");
    const after = { name: nameOf(focusedTile).fontWeight, ring: frameOf(focusedTile).borderColor };
    console.info(TAG, "Kids unfocused", JSON.stringify(before), "focused", JSON.stringify(after));
    expect(after.ring).toBe("#ffffff");
    expect(after.ring).not.toBe(before.ring);
    expect(after.name).toBe("700");
    expect(nameOf(one(renderer, "profile-tile-0")).fontWeight).not.toBe("700");
  });

  it("Manage profiles has one Edit per profile and no rename; Edit opens the chooser on the profile's avatar", async () => {
    const renderer = start([profile("p-main", "Chris", "badger", true), profile("p-two", "Sam", "fox")], "manage");
    expect(avatarIn(one(renderer, "profile-row-1")).props.source).toBe(sourceOf("fox"));
    const ids = renderer.root.findAll((node) => typeof node.props.testID === "string").map((node) => String(node.props.testID));
    console.info(TAG, "manage test ids", JSON.stringify(ids));
    expect(ids.some((id) => id.includes("rename"))).toBe(false);

    console.info(TAG, "phase: Edit Sam");
    await press(renderer, "profile-edit-1");
    expect(one(renderer, "profile-edit").props.children).toBe("profiles.editTitle");
    expect(one(renderer, "profile-name-input").props.value).toBe("Sam");
    const options = renderer.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "radio");
    expect(options.map((node) => String(node.props.testID).replace("avatar-option-", ""))).toEqual([...PROFILE_AVATAR_IDS]);
    // Two rows of 11: the grid is as wide as 11 cells and their gaps.
    expect(TV_AVATAR_COLUMNS * 2).toBe(PROFILE_AVATAR_IDS.length);
    expect(selectedOptions(renderer)).toEqual(["fox"]);
    expect(byTestId(renderer, "avatar-option-tick")).toHaveLength(1);

    console.info(TAG, "phase: focus the whale (white ring), OK picks it, Save");
    act(() => one(renderer, "avatar-option-whale").props.onFocus());
    expect(flatStyle(one(renderer, "avatar-option-whale").props.style).borderColor).toBe("#ffffff");
    await press(renderer, "avatar-option-whale");
    expect(selectedOptions(renderer)).toEqual(["whale"]);
    expect(one(renderer, "profile-avatar-preview").props.source).toBe(sourceOf("whale"));
    await press(renderer, "profile-save");
    console.info(TAG, "edited", JSON.stringify(ctl.edited));
    expect(ctl.edited).toEqual([{ id: "p-two", change: { name: "Sam", avatarId: "whale" } }]);
    expect(avatarIn(one(renderer, "profile-row-1")).props.source).toBe(sourceOf("whale"));
  });

  it("Manage profiles rows stay inside the TV safe area, so the avatar and Delete are never cut (UX-TV-13)", () => {
    // Seen on the 1280x720 Android TV emulator: 900 dp rows in a 960 − 2 × 48 dp list lost 18 dp on each side.
    const renderer = start([profile("p-main", "Chris", "cat", true), profile("p-two", "Kids", "moon")], "manage");
    const row = flatStyle(one(renderer, "profile-row-0").props.style);
    console.info(TAG, "manage row style", JSON.stringify(row));
    expect(row.width).toBeUndefined();
    expect(row.alignSelf).toBe("stretch");
  });

  it("the Add profile tile opens the chooser on the first unused avatar and Save creates the profile with it, set up (UX-SETUP-10)", async () => {
    const renderer = start([profile("p-main", "Chris", "badger", true)], "pick");
    console.info(TAG, "phase: Add profile tile");
    await press(renderer, "profile-add-tile");
    expect(one(renderer, "profile-edit").props.children).toBe("profiles.addTitle");
    expect(selectedOptions(renderer)).toEqual(["parrot"]);
    act(() => one(renderer, "profile-name-input").props.onChangeText("Robin"));
    await press(renderer, "profile-save");
    console.info(TAG, "created", JSON.stringify(ctl.created));
    expect(ctl.created).toEqual([{ name: "Robin", avatarId: "parrot", features: { avatars: "set" } }]);
    expect(avatarIn(one(renderer, "profile-tile-1")).props.source).toBe(sourceOf("parrot"));
  });

  it("submitting the name from the keyboard keeps it and moves the focus to the chosen avatar instead of saving (ACCT-PROF-05)", async () => {
    // tvOS: the keyboard's "done" is the only key that keeps the typed text, so a submit that saved left no way to pick an avatar.
    vi.useFakeTimers();
    try {
      const renderer = start([profile("p-main", "Chris", "badger", true), profile("p-two", "Kids", "rocket")], "manage");
      await press(renderer, "profile-edit-1");
      expect(one(renderer, "avatar-option-rocket").props.hasTVPreferredFocus).toBe(false);
      act(() => one(renderer, "profile-name-input").props.onChangeText("Kiddos"));
      act(() => one(renderer, "profile-name-input").props.onSubmitEditing());
      console.info(TAG, "after submit: edited", JSON.stringify(ctl.edited), "focus requests", JSON.stringify(ctl.focusRequests));
      expect(ctl.edited).toEqual([]);
      expect(one(renderer, "profile-edit").props.children).toBe("profiles.editTitle");
      expect(one(renderer, "profile-name-input").props.value).toBe("Kiddos");
      expect(one(renderer, "avatar-option-rocket").props.hasTVPreferredFocus).toBe(true);
      expect(ctl.focusRequests).toEqual(["avatar-option-rocket"]);

      console.info(TAG, "phase: the keyboard closes and UIKit's focus update lands on the first avatar: the chosen one takes it back once");
      act(() => one(renderer, "avatar-option-badger").props.onFocus());
      expect(ctl.focusRequests).toEqual(["avatar-option-rocket", "avatar-option-rocket"]);
      act(() => one(renderer, "avatar-option-badger").props.onBlur());
      act(() => one(renderer, "avatar-option-rocket").props.onFocus());
      act(() => one(renderer, "avatar-option-rocket").props.onBlur());
      act(() => one(renderer, "avatar-option-moon").props.onFocus());
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(ctl.focusRequests).toHaveLength(2);

      console.info(TAG, "phase: the remote goes back up to the name, \"done\" again; the keyboard closing puts the focus back on the name field");
      act(() => one(renderer, "avatar-option-moon").props.onBlur());
      act(() => one(renderer, "profile-name-input").props.onChangeText("Kiddos Two"));
      act(() => one(renderer, "profile-name-input").props.onSubmitEditing());
      expect(ctl.focusRequests).toHaveLength(3);
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(ctl.focusRequests).toHaveLength(3);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      console.info(TAG, "after the second submit settles: focus requests", JSON.stringify(ctl.focusRequests));
      expect(ctl.focusRequests).toEqual(["avatar-option-rocket", "avatar-option-rocket", "avatar-option-rocket", "avatar-option-rocket"]);
      expect(ctl.edited).toEqual([]);

      await press(renderer, "avatar-option-moon");
      await press(renderer, "profile-save");
      expect(ctl.edited).toEqual([{ id: "p-two", change: { name: "Kiddos Two", avatarId: "moon" } }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TvProfilesScreen limits (ACCT-PROF-01, ACCT-PROF-02)", () => {
  it("a free account's Manage profiles keeps Add profile greyed and says a free account has one, paid plans up to 5", () => {
    const renderer = start([profile("p-main", "Chris", "badger", true)], "manage", 1);
    const add = one(renderer, "profile-add");
    const note = one(renderer, "profile-add-limit");
    console.info(TAG, "free: add disabled", add.props.disabled, "note", note.props.children);
    expect(add.props.disabled).toBe(true);
    expect(note.props.children).toBe('profiles.limitFree {"paidMax":5}');
  });

  it("a full paid account says it has its 5 profiles, and \"Who's watching?\" has no Add tile", () => {
    const five = (["badger", "fox", "cat", "owl", "dino"] as const).map((avatar, index) => profile(`p-${index}`, `P${index}`, avatar, index === 0));
    const manage = start(five, "manage", 5);
    console.info(TAG, "paid full note", one(manage, "profile-add-limit").props.children);
    expect(one(manage, "profile-add").props.disabled).toBe(true);
    expect(one(manage, "profile-add-limit").props.children).toBe('profiles.errors.limit {"max":5}');
    const pick = start(five, "pick", 5);
    expect(byTestId(pick, "profile-add-tile")).toHaveLength(0);
  });

  it("a paid account with room shows Add profile enabled and no note", () => {
    const renderer = start([profile("p-main", "Chris", "badger", true)], "manage", 5);
    expect(one(renderer, "profile-add").props.disabled).toBe(false);
    expect(byTestId(renderer, "profile-add-limit")).toHaveLength(0);
  });

  it("deleting the last profile is refused with the reason, without asking to confirm", async () => {
    const renderer = start([profile("p-main", "Chris", "badger", true)], "manage", 5);
    await press(renderer, "profile-delete-0");
    console.info(TAG, "last delete error", one(renderer, "profiles-error").props.children);
    expect(String(one(renderer, "profiles-error").props.children)).toMatch(/^profiles\.errors\.last/);
    expect(byTestId(renderer, "profile-delete-confirm")).toHaveLength(0);
  });

  it("opening the screen re-reads the profile list once", () => {
    start([profile("p-main", "Chris", "badger", true)], "pick", 5);
    console.info(TAG, "refreshes on open", ctl.refreshes);
    expect(ctl.refreshes).toBe(1);
  });
});

describe("TvProfilesScreen limits without a remount (ACCT-PROF-01)", () => {
  it("adding the 5th profile greys Add with the note at once, and deleting one brings Add back", async () => {
    const four = (["badger", "fox", "cat", "owl"] as const).map((avatar, index) => profile(`p-${index}`, `P${index}`, avatar, index === 0));
    const renderer = start(four, "manage", 5);
    ctl.compilerCache = true;
    expect(one(renderer, "profile-add").props.disabled).toBe(false);

    console.info(TAG, "phase: add the 5th from Manage profiles");
    await press(renderer, "profile-add");
    act(() => one(renderer, "profile-name-input").props.onChangeText("Robin"));
    await press(renderer, "profile-save");
    console.info(TAG, "after add: disabled", one(renderer, "profile-add").props.disabled, "note", byTestId(renderer, "profile-add-limit")[0]?.props.children);
    expect(ctl.created).toHaveLength(1);
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
