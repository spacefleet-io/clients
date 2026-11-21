/**
 * @test-id MOBILE-SHELL-PROFILE-SETUP-001
 * @level component
 * @why Chris 2026-11-18 approved "Your profile" (UX-SETUP-10, design `phone-step.png`) and the "New in this update"
 *   window (UX-UPDATE-01, design `phone-modal.png`) for both phone apps. The step shows the profile's name in a field,
 *   its avatar big and the 22 avatars round, five across, the chosen one ringed; Next sends ONE PATCH with the name, the
 *   avatar and `features.avatars = "set"`, even unchanged, and a failure stays on the step with the reason. The window
 *   names the profile in bold; "Choose my avatar" opens the step and "Later" records `features.avatars = "later"`,
 *   closing the window for this run even offline. Rendered with react-test-renderer: react-native is replaced by
 *   host-element stand-ins, the setup chrome by a plain card with Back and Next, and the profile store by a fake.
 */
// @req UX-SETUP-10[badger-mobile] @req UX-SETUP-10[parrot] @req UX-UPDATE-01[badger-mobile] @req UX-UPDATE-01[parrot]
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ProfileFeatures } from "@space/shared/appFeatures";
import type { ApiProfile } from "@space/shared/profiles";
import { ProfileActionError, type ProfileStore } from "@space/shared/profileStore";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, absoluteFillObject: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ Check: "Check", ChevronLeft: "ChevronLeft", Plus: "Plus" }));
// The app's colour: Badger's amber unless a test draws Parrot's green.
const accent = vi.hoisted(() => ({ hex: "#ffb04c" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { text: "#fff", textMuted: "#aaa", textDim: "#777", accent: accent.hex, danger: "#ed8084", border: "#44475a", surface: "#242638", surfaceRaised: "#2b2d42", background: "#000" },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    font: { family: { display: "Display" }, size: { md: 16 } },
    accentTextHex: "#1a1a1a",
  }),
}));
// Keys come back as they are, with their values, so the test reads which text each element asks for.
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === "profiles.whatsNew.avatars.text" ? `Give ${String(values?.name)} a face.` : values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
// The shared setup chrome is its own tests' business: here a card with the step label, Back and Next.
vi.mock("../src/components/mobile-setup-step", () => ({
  MobileSetupStep: (props: {
    step: number;
    total: number;
    header?: React.ReactNode;
    title: string;
    onBack?: () => void;
    onNext?: () => void;
    nextDisabled?: boolean;
    busy?: boolean;
    children?: React.ReactNode;
  }) =>
    // Runs at render time, after the file's imports, so the imported React is there.
    React.createElement(
      "View",
      { testID: "setup-card" },
      props.header === null ? null : React.createElement("Text", { testID: "setup-step-indicator" }, `step ${props.step} of ${props.total}`),
      React.createElement("Text", { testID: "setup-title" }, props.title),
      props.children,
      React.createElement("Pressable", { testID: "setup-back", disabled: !props.onBack, onPress: props.onBack }),
      React.createElement("Pressable", { testID: "setup-next", disabled: !props.onNext || props.nextDisabled, onPress: props.onNext }),
    ),
}));
// vi.mock factories run before the file's imports, so the id list loads inside it (as in the avatars test).
vi.mock("@space/profile-avatars/native", async () => {
  const { PROFILE_AVATAR_IDS: ids } = await import("@space/shared/profileAvatars");
  return { PROFILE_AVATAR_SOURCES: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
});

import { AvatarGrid } from "../src/profiles/AvatarGrid";
import { ProfileSetupStep } from "../src/profiles/ProfileSetupStep";
import { WhatsNewModal } from "../src/profiles/WhatsNewModal";
import {
  activeProfileNeedsSetup,
  bindProfileSetup,
  updateFeatureQueue,
  useUpdateFeatures,
  type UpdateFeatures,
} from "../src/profiles/profileSetup";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAG = "[MOBILE-SHELL-PROFILE-SETUP-001]";
const NEW = "2026-11-20T10:00:00.000Z";
const OLD = "2026-11-10T10:00:00.000Z";

const profile = (id: string, name: string, avatarId: ProfileAvatarId, createdAt: string, features: ProfileFeatures = {}): ApiProfile => ({
  id,
  name,
  avatar: 0,
  avatarId,
  features,
  createdAt,
  isMain: id === "p-main",
});

type Edit = { id: string; change: { name?: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures } };

/** A store whose `editProfile` records each PATCH; `fail` makes the next ones throw. */
const bindFake = () => {
  const edits: Edit[] = [];
  const events: string[] = [];
  const state = { fail: null as string | null };
  const store = {
    editProfile: async (id: string, change: Edit["change"]) => {
      edits.push({ id, change });
      if (state.fail) throw new ProfileActionError(state.fail as never);
    },
  } as unknown as ProfileStore;
  bindProfileSetup({
    store,
    log: (event, data) => {
      events.push(event);
      console.info(TAG, "log", event, JSON.stringify(data));
    },
  });
  return { edits, events, state };
};

const byId = (renderer: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (renderer: ReactTestRenderer, testID: string) => {
  const found = byId(renderer, testID);
  expect(found, testID).toHaveLength(1);
  return found[0]!;
};
const press = async (renderer: ReactTestRenderer, testID: string) => {
  await act(async () => {
    one(renderer, testID).props.onPress();
  });
};
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
type FlatStyle = Record<string, string | number | undefined>;
/** A style prop (an object or nested arrays of them, `false` for an unused one) merged as React Native draws it. */
const flattenStyle = (style: unknown): FlatStyle => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === "object" ? { ...style } : {};
};

describe("which profile gets what (UX-SETUP-10, UX-UPDATE-01)", () => {
  it("a profile made since the avatars gets the step, an older one the window, and an answer ends both", () => {
    const fresh = profile("p-new", "Sam", "owl", NEW);
    const old = profile("p-main", "Marie", "badger", OLD);
    console.info(TAG, "phase=queues", updateFeatureQueue(fresh), updateFeatureQueue(old));
    expect(activeProfileNeedsSetup({ profiles: [fresh], activeId: "p-new" })).toBe(true);
    expect(activeProfileNeedsSetup({ profiles: [old], activeId: "p-main" })).toBe(false);
    expect(activeProfileNeedsSetup({ profiles: [old], activeId: null })).toBeNull();
    expect(updateFeatureQueue(fresh)).toEqual([]);
    expect(updateFeatureQueue(old)).toEqual(["avatars"]);
    expect(updateFeatureQueue(profile("p-main", "Marie", "badger", OLD, { avatars: "later" }))).toEqual([]);
    expect(activeProfileNeedsSetup({ profiles: [profile("p-new", "Sam", "owl", NEW, { avatars: "set" })], activeId: "p-new" })).toBe(false);
  });
});

describe("Your profile on the phones (UX-SETUP-10)", () => {
  it("shows the name, the avatar big and the 22 round, the chosen one ringed, numbered during the setup", async () => {
    bindFake();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProfileSetupStep profile={profile("p-new", "Marie", "owl", NEW)} position={{ step: 2, total: 5 }} onDone={() => undefined} />);
    });
    console.info(TAG, "phase=render", textOf(one(renderer, "setup-step-indicator")));
    expect(textOf(one(renderer, "setup-step-indicator"))).toBe("step 2 of 5");
    expect(textOf(one(renderer, "setup-title"))).toBe("profiles.setup.title");
    expect(one(renderer, "profile-setup-name").props.value).toBe("Marie");
    expect(one(renderer, "profile-setup-avatar").props.source).toBe(PROFILE_AVATAR_IDS.indexOf("owl") + 1);
    for (const id of PROFILE_AVATAR_IDS) one(renderer, `avatar-option-${id}`);
    expect(one(renderer, "avatar-option-owl").findAll((node) => node.props.testID === "avatar-option-ring")).not.toHaveLength(0);
    expect(byId(renderer, "avatar-option-ring")).toHaveLength(1);
    expect(byId(renderer, "avatar-option-tick")).toHaveLength(0);
    // Alone (a profile picked later, or from the window): no count.
    await act(async () => {
      renderer.update(<ProfileSetupStep profile={profile("p-new", "Marie", "owl", NEW)} onDone={() => undefined} />);
    });
    expect(byId(renderer, "setup-step-indicator")).toHaveLength(0);
  });

  it("Next sends one PATCH with the name, the avatar picked and avatars set, then moves on", async () => {
    const { edits, events } = bindFake();
    const done = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProfileSetupStep profile={profile("p-new", "Marie", "owl", NEW)} onDone={done} />);
    });
    await act(async () => {
      one(renderer, "profile-setup-name").props.onChangeText("Marie-Lou");
    });
    await press(renderer, "avatar-option-panda");
    expect(byId(renderer, "avatar-option-panda")[0]!.findAll((node) => node.props.testID === "avatar-option-ring")).not.toHaveLength(0);
    await press(renderer, "setup-next");
    console.info(TAG, "phase=saved", JSON.stringify(edits), events.join(","));
    expect(edits).toEqual([{ id: "p-new", change: { name: "Marie-Lou", avatarId: "panda", features: { avatars: "set" } } }]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("Next saves even with nothing changed, so no other device asks again", async () => {
    const { edits } = bindFake();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProfileSetupStep profile={profile("p-new", "Sam", "fox", NEW)} onDone={() => undefined} />);
    });
    await press(renderer, "setup-next");
    expect(edits).toEqual([{ id: "p-new", change: { name: "Sam", avatarId: "fox", features: { avatars: "set" } } }]);
  });

  it("an empty name greys Next; a failed save stays on the step with the reason", async () => {
    const { edits, state } = bindFake();
    const done = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProfileSetupStep profile={profile("p-new", "Sam", "fox", NEW)} onDone={done} />);
    });
    await act(async () => {
      one(renderer, "profile-setup-name").props.onChangeText("   ");
    });
    expect(one(renderer, "setup-next").props.disabled).toBe(true);
    await act(async () => {
      one(renderer, "profile-setup-name").props.onChangeText("Sam");
    });
    state.fail = "offline";
    await press(renderer, "setup-next");
    console.info(TAG, "phase=failed", textOf(one(renderer, "profile-setup-error")));
    expect(edits).toHaveLength(1);
    expect(done).not.toHaveBeenCalled();
    expect(textOf(one(renderer, "profile-setup-error"))).toContain("profiles.errors");
  });
});

describe("New in this update on the phones (UX-UPDATE-01)", () => {
  it("names the profile in bold over the avatars art, with Choose my avatar and Later", async () => {
    const choose = vi.fn();
    const later = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<WhatsNewModal feature="avatars" profileName="Marie" onChoose={choose} onLater={later} />);
    });
    console.info(TAG, "phase=window", textOf(one(renderer, "whats-new-text")));
    one(renderer, "whats-new-avatars");
    expect(textOf(one(renderer, "whats-new-text"))).toBe("Give Marie a face.");
    expect(textOf(one(renderer, "whats-new-name"))).toBe("Marie");
    for (const id of ["fox", "owl", "panda", "rocket", "octopus"]) one(renderer, `whats-new-art-${id}`);
    const all = renderer.root.findAll((node) => typeof node.props.children === "string").map((node) => node.props.children as string);
    expect(all).toEqual(expect.arrayContaining(["profiles.whatsNew.avatars.title", "profiles.whatsNew.avatars.cta", "profiles.whatsNew.later"]));
    await press(renderer, "whats-new-choose");
    await press(renderer, "whats-new-later");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("draws the badge in the app's own colour: Parrot's green text on Parrot's green at 10%, never Badger's amber", async () => {
    for (const hex of ["#40dd8f", "#ffb04c"]) {
      accent.hex = hex;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<WhatsNewModal feature="avatars" profileName="Marie" onChoose={() => undefined} onLater={() => undefined} />);
      });
      const badge = one(renderer, "whats-new-badge");
      const fill = flattenStyle(badge.props.style).backgroundColor;
      const text = flattenStyle(badge.findAll((node) => String(node.type) === "Text")[0]!.props.style).color;
      console.info(TAG, "phase=badge", hex, fill, text);
      expect(fill).toBe(`${hex}1a`);
      expect(text).toBe(hex);
    }
    accent.hex = "#ffb04c";
  });

  it("Later records avatars later and closes the window, for this run even when the PATCH fails", async () => {
    const { edits, state } = bindFake();
    state.fail = "offline";
    let updates!: UpdateFeatures;
    const Probe = ({ of }: { of: ApiProfile }) => {
      updates = useUpdateFeatures(of);
      return null;
    };
    const old = profile("p-later", "Marie", "badger", OLD);
    await act(async () => {
      create(<Probe of={old} />);
    });
    expect(updates.current).toBe("avatars");
    await act(async () => {
      await updates.later("avatars");
    });
    console.info(TAG, "phase=later", JSON.stringify(edits), updates.current);
    expect(edits).toEqual([{ id: "p-later", change: { features: { avatars: "later" } } }]);
    expect(updates.current).toBeNull();
  });

  it("Choose my avatar opens the step, Back returns to the window, and a saved answer ends both", async () => {
    bindFake();
    let updates!: UpdateFeatures;
    const Probe = ({ of }: { of: ApiProfile }) => {
      updates = useUpdateFeatures(of);
      return null;
    };
    const old = profile("p-choose", "Marie", "badger", OLD);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe of={old} />);
    });
    await act(async () => updates.setUp("avatars"));
    expect(updates.settingUp).toBe("avatars");
    expect(updates.current).toBeNull();
    await act(async () => updates.back());
    expect(updates.settingUp).toBeNull();
    expect(updates.current).toBe("avatars");
    await act(async () => updates.setUp("avatars"));
    await act(async () => {
      renderer.update(<Probe of={{ ...old, features: { avatars: "set" } }} />);
    });
    console.info(TAG, "phase=set", updates.settingUp, updates.current);
    expect(updates.settingUp).toBeNull();
    expect(updates.current).toBeNull();
  });
});

describe("the one avatar grid (ACCT-PROF-05)", () => {
  it("draws the manager's square ticked cells by default and the step's round ringed ones on request", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AvatarGrid value="robot" onChange={() => undefined} />);
    });
    // The square cells are sized from the grid's width, known after its first layout.
    await act(async () => {
      one(renderer, "avatar-chooser").props.onLayout({ nativeEvent: { layout: { width: 360 } } });
    });
    expect(byId(renderer, "avatar-option-tick")).toHaveLength(1);
    expect(byId(renderer, "avatar-option-ring")).toHaveLength(0);
    await act(async () => {
      renderer.update(<AvatarGrid variant="round" columns={5} value="robot" onChange={() => undefined} />);
    });
    expect(byId(renderer, "avatar-option-ring")).toHaveLength(1);
    expect(byId(renderer, "avatar-option-tick")).toHaveLength(0);
  });

  it("fills the card's content width with the round avatars, so the grid lines up with the text and the ring stays in the card", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AvatarGrid variant="round" columns={5} value="owl" onChange={() => undefined} />);
    });
    // A 360 dp phone: 360 - 2 x 24 (screen) - 2 x 24 (card) - 2 (border) = 262 dp of content.
    await act(async () => {
      one(renderer, "avatar-chooser").props.onLayout({ nativeEvent: { layout: { width: 262 } } });
    });
    const grid = flattenStyle(one(renderer, "avatar-chooser").props.style);
    const cell = flattenStyle(one(renderer, "avatar-option-owl").props.style);
    const ring = flattenStyle(one(renderer, "avatar-option-ring").props.style);
    console.info(TAG, "phase=round-grid", JSON.stringify({ grid, cell, ring }));
    expect(grid.width).toBeUndefined();
    expect(grid.alignSelf).toBe("stretch");
    expect(cell.width).toBe(42);
    expect(5 * Number(cell.width) + 4 * 12).toBeLessThanOrEqual(262);
    // The ring reaches 7 dp past the avatar: inside the card's 24 dp padding.
    expect(ring.left).toBe(-7);
    expect(ring.width).toBe(56);
    // A wide phone: never past 56 dp.
    await act(async () => {
      one(renderer, "avatar-chooser").props.onLayout({ nativeEvent: { layout: { width: 400 } } });
    });
    expect(flattenStyle(one(renderer, "avatar-option-owl").props.style).width).toBe(56);
  });
});
