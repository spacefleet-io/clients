/**
 * @test-id PARROT-MOBILE-PROFILE-AVATARS-001
 * @level component
 * @why ACCT-PROF-05: Parrot's phone shows the same built-in avatars as Badger's, through the same shared screen
 *   (`@space/mobile-shell/profiles-screen`) on Parrot's own profile store. "Who's listening?" draws each profile's
 *   avatar on its tile; adding a profile opens the chooser on the first avatar nobody uses and sends the picked one
 *   to the API; Edit in Manage profiles sends the new avatar and shows it on the row. The screens were also tried by
 *   hand on a phone (test package `io.spacefleet.parrot.e2e`, 2026-11-18). Rendered with react-test-renderer:
 *   react-native is replaced by host-element stand-ins, the API by an in-memory fake behind Parrot's real store.
 */
// @req ACCT-PROF-05[parrot]
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { NO_LIBRARY_MOVES, type ProfileStore } from "@space/shared/profileStore";

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
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("../../../../packages/mobile-shell/src/components/mobile-button", () => ({ MobileButton: "MobileButton" }));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({
    colors: {
      text: "#fff",
      textMuted: "#aaa",
      textDim: "#777",
      accent: "#3fb950",
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
// Keys come back as they are, so the test reads which text each element asks for.
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
// One number per picture, as Metro's require gives: the pack order plus one. vi.mock factories run before the file's
// imports, so the id list loads inside the factory.
vi.mock("@space/profile-avatars/native", async () => {
  const { PROFILE_AVATAR_IDS: ids } = await import("@space/shared/profileAvatars");
  return { PROFILE_AVATAR_SOURCES: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
});

import { MobileProfilesScreen } from "@space/mobile-shell/profiles-screen";
import { createParrotProfileStore } from "../src/lib/profiles";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAG = "[PARROT-MOBILE-PROFILE-AVATARS-001]";
const sourceOf = (id: ProfileAvatarId) => PROFILE_AVATAR_IDS.indexOf(id) + 1;

const profile = (id: string, isMain: boolean, name: string, avatarId: ProfileAvatarId): ApiProfile =>
  ({ id, isMain, name, avatar: 0, avatarId, createdAt: "2026-11-18T00:00:00.000Z" }) as ApiProfile;

/** Parrot's API as the store calls it, recording each create and update body. */
const fakeApi = (start: ApiProfile[]) => {
  let profiles = [...start];
  const sent = { created: [] as unknown[], updated: [] as unknown[] };
  const list = (): ProfilesResponse => ({ profiles, maxProfiles: 5 });
  const api = {
    list: async () => list(),
    create: async (_token: string, body: { name: string; avatarId?: ProfileAvatarId }) => {
      sent.created.push(body);
      const made = profile(`p${profiles.length + 1}`, false, body.name, body.avatarId ?? "badger");
      profiles = [...profiles, made];
      return { ...list(), profile: made };
    },
    update: async (_token: string, id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => {
      sent.updated.push({ id, ...body });
      profiles = profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
      return { ...list(), profile: profiles.find((p) => p.id === id)! };
    },
    remove: async (_token: string, id: string) => {
      profiles = profiles.filter((p) => p.id !== id);
      return list();
    },
  };
  return { api, sent };
};

const memoryStorage = () => {
  const saved = new Map<string, string>();
  return {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void saved.set(key, value),
    removeItem: async (key: string) => void saved.delete(key),
  };
};

const startedStore = async (profiles: ApiProfile[]) => {
  const { api, sent } = fakeApi(profiles);
  const store = createParrotProfileStore({ storage: memoryStorage(), api });
  await store.startSession({ userId: "user-1", token: "t", askEveryStart: false });
  return { store, sent };
};

const render = (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
};
const one = (renderer: ReactTestRenderer, testID: string): ReactTestInstance => {
  const found = renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
  expect(found, `${testID} is on screen once`).toHaveLength(1);
  return found[0]!;
};
const avatarIn = (node: ReactTestInstance) =>
  node.findAll((child) => child.props.testID === "profile-avatar" && typeof child.type === "string")[0]!;
const press = async (renderer: ReactTestRenderer, testID: string) => {
  console.info(TAG, "press", testID);
  await act(async () => {
    await one(renderer, testID).props.onPress();
  });
};
const layOutChooser = (renderer: ReactTestRenderer) =>
  act(() => {
    one(renderer, "avatar-chooser").props.onLayout({ nativeEvent: { layout: { width: 360, height: 0 } } });
  });
const selectedOptions = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => typeof node.type === "string" && String(node.props.testID ?? "").startsWith("avatar-option-") && node.props.accessibilityRole === "radio")
    .filter((node) => node.props.accessibilityState?.selected)
    .map((node) => String(node.props.testID).replace("avatar-option-", ""));

const screen = (store: ProfileStore, startMode: "pick" | "manage") =>
  render(
    <MobileProfilesScreen
      store={store}
      moves={NO_LIBRARY_MOVES}
      startMode={startMode}
      audience="listening"
      onClose={null}
      log={(event, data) => console.info(TAG, "flow", event, JSON.stringify(data))}
    />,
  );

describe("Parrot phone profile avatars (ACCT-PROF-05)", () => {
  it("\"Who's listening?\" shows each profile's avatar, and Add sends the avatar picked in the chooser", async () => {
    const { store, sent } = await startedStore([profile("main", true, "Chris", "owl"), profile("p2", false, "Lea", "fox")]);
    const renderer = screen(store, "pick");
    const title = renderer.root.findAll((node) => typeof node.type === "string" && node.props.children === "profiles.whoIsListening");
    expect(title.length).toBeGreaterThan(0);
    expect(avatarIn(one(renderer, "profile-tile-0")).props.source).toBe(sourceOf("owl"));
    expect(avatarIn(one(renderer, "profile-tile-1")).props.source).toBe(sourceOf("fox"));

    console.info(TAG, "phase: add tile -> chooser on the first avatar nobody uses");
    await press(renderer, "profile-add-tile");
    layOutChooser(renderer);
    expect(selectedOptions(renderer)).toEqual(["badger"]);
    act(() => one(renderer, "profile-name-input").props.onChangeText("Sam"));
    await press(renderer, "avatar-option-robot");
    await press(renderer, "profile-save");
    console.info(TAG, "sent", JSON.stringify(sent));
    expect(sent.created).toEqual([{ name: "Sam", avatarId: "robot", features: { avatars: "set" } }]);
    expect(avatarIn(one(renderer, "profile-tile-2")).props.source).toBe(sourceOf("robot"));
  });

  it("Edit in Manage profiles sends the new avatar and the row shows it", async () => {
    const { store, sent } = await startedStore([profile("main", true, "Chris", "badger"), profile("p2", false, "Lea", "fox")]);
    const renderer = screen(store, "manage");
    expect(avatarIn(one(renderer, "profile-row-1")).props.source).toBe(sourceOf("fox"));

    await press(renderer, "profile-edit-1");
    layOutChooser(renderer);
    expect(selectedOptions(renderer)).toEqual(["fox"]);
    await press(renderer, "avatar-option-whale");
    await press(renderer, "profile-save");
    console.info(TAG, "sent", JSON.stringify(sent));
    expect(sent.updated).toEqual([{ id: "p2", name: "Lea", avatarId: "whale" }]);
    expect(avatarIn(one(renderer, "profile-row-1")).props.source).toBe(sourceOf("whale"));
  });
});
