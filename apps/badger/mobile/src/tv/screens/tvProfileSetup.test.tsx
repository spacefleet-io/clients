/**
 * @test-id TV-PROFILE-SETUP-001
 * @level component
 * @why Chris 2026-11-18 approved "Your profile" (UX-SETUP-10, design `tv-step.png`) and "New in this update"
 *   (UX-UPDATE-01, design `desktop-modal.png`, on the TV with the focus on "Choose my avatar"). On the TV the step shows
 *   the 22 avatars in six columns from the shared TV grid, the focus starting on the profile's avatar; the big avatar on
 *   the left follows the remote's focus; the name is not edited on the TV. Next sends one save with the name and the
 *   chosen avatar (even unchanged), keeps the step counted for the rest of the setup when it is numbered, then moves on.
 *   The window over the home holds the remote's focus in its card, starts on the main button, draws the profile's name
 *   in bold, and Later (or Back) answers Later. Rendered with react-test-renderer at 1920x1080 with the real English and
 *   French texts; the shared save and the TV progress store are fakes.
 *
 * @req UX-SETUP-10[badger-tv]
 * @req UX-UPDATE-01[badger-tv]
 * @req UX-SETUP-04[badger-tv]
 * @req UX-SETUP-08[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile } from "@space/shared/profiles";

const TAG = "[TV-PROFILE-SETUP-001]";

const ctl = vi.hoisted(() => ({
  saves: [] as Array<{ profileId: string; change: { name: string; avatarId: string } }>,
  saveError: null as Error | null,
  answered: 0,
  backHandlers: [] as Array<() => boolean>,
  log: [] as string[],
  /** The Apple TV Menu key holds by reason, as the screens leave them. */
  menuHolds: {} as Record<string, boolean>,
}));

vi.mock("react-native", async () => ({
  ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
  Platform: { isTV: true, OS: "android", constants: {}, select: (choices: Record<string, unknown>) => choices.android ?? choices.default },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      ctl.backHandlers.push(handler);
      return { remove: () => ctl.backHandlers.splice(ctl.backHandlers.indexOf(handler), 1) };
    },
  },
  useWindowDimensions: () => ({ width: 1920, height: 1080, scale: 1, fontScale: 1 }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("lucide-react-native", async () => (await import("../../../tests/setup/lucideMock")).lucideStandIns());
vi.mock("@space/mobile-shell/components", () => ({ MobileAppBackdrop: "MobileAppBackdrop" }));
vi.mock("@space/profile-avatars/native", async () => {
  const { PROFILE_AVATAR_IDS: ids } = await import("@space/shared/profileAvatars");
  return { PROFILE_AVATAR_SOURCES: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
});
vi.mock("@space/mobile-shell/profile-setup", () => ({
  UPDATE_FEATURES: {
    avatars: {
      titleKey: "profiles.whatsNew.avatars.title",
      textKey: "profiles.whatsNew.avatars.text",
      ctaKey: "profiles.whatsNew.avatars.cta",
      art: ["fox", "owl", "panda", "rocket", "octopus"],
    },
  },
  saveProfileSetup: async (profile: ApiProfile, change: { name: string; avatarId: string }) => {
    ctl.log.push("save");
    ctl.saves.push({ profileId: profile.id, change });
    if (ctl.saveError) throw ctl.saveError;
  },
}));
vi.mock("../lib/tvSetupStore", () => ({
  markTvProfileSetupAnswered: async () => {
    ctl.log.push("answered");
    ctl.answered += 1;
  },
}));
vi.mock("../lib/useTvMenuKey", async () => {
  const { useEffect } = await import("react");
  return {
    useTvMenuKeyHold: (reason: string, active: boolean) => {
      useEffect(() => {
        ctl.menuHolds[reason] = active;
        return () => {
          ctl.menuHolds[reason] = false;
        };
      }, [reason, active]);
    },
  };
});

import { ProfileActionError } from "@space/shared/profileStore";
import { TV_AVATAR_FOCUS_SETTLE_MS, TV_AVATAR_GRID_LAYOUT, TV_SETUP_AVATAR_FOCUS_SCALE } from "../components/TvAvatarGrid";
import { setupMascotOverlap, TV_SETUP_MASCOT_SIZE } from "@space/mobile-shell/setup-step";
import { TV_PROFILE_SETUP_PREVIEW, TvProfileSetupScreen } from "./TvProfileSetupScreen";
import { TV_WHATS_NEW_HOLD_MS, TvWhatsNewWindow } from "./TvWhatsNewWindow";

/** The host view's testID, for the node mocks that stand in for native views. */
const testIdOf = (element: React.ReactElement): string | undefined => {
  const props: unknown = element.props;
  return props && typeof props === "object" && "testID" in props && typeof props.testID === "string" ? props.testID : undefined;
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sourceOf = (id: ProfileAvatarId) => PROFILE_AVATAR_IDS.indexOf(id) + 1;
const marie: ApiProfile = {
  id: "p-marie",
  name: "Marie",
  avatar: 0,
  avatarId: "fox",
  createdAt: "2026-11-19T10:00:00.000Z",
  isMain: false,
  features: {},
};

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  await initI18n("en");
  await changeLanguage("en");
  ctl.saves.length = 0;
  ctl.saveError = null;
  ctl.answered = 0;
  ctl.backHandlers.length = 0;
  ctl.log.length = 0;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const render = (element: React.ReactElement) => {
  act(() => {
    renderer = create(element);
  });
  return renderer!;
};
const hosts = (root: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (root: ReactTestRenderer, testID: string) => {
  const found = hosts(root, testID);
  expect(found, `${testID} is on screen once`).toHaveLength(1);
  return found[0]!;
};
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const allText = (root: ReactTestRenderer) =>
  root.root
    .findAll((node) => (node.type as unknown) === "Text")
    .map(textOf)
    .join(" | ");
const flatStyle = (style: unknown, focused = false): Record<string, unknown> => {
  const resolved = typeof style === "function" ? style({ focused, pressed: false }) : style;
  if (Array.isArray(resolved)) return Object.assign({}, ...resolved.map((s) => flatStyle(s, focused)));
  return resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
};
const press = async (root: ReactTestRenderer, testID: string) => {
  console.info(TAG, "press", testID);
  await act(async () => {
    one(root, testID).props.onPress();
  });
};

describe("TvProfileSetupScreen (UX-SETUP-10)", () => {
  it("draws the design: step count, title, lead, big avatar, name with the rename hint, six columns, focus on the profile's avatar", () => {
    const root = render(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 2, total: 3 }} onBack={() => undefined} onDone={() => undefined} />);
    const text = allText(root);
    console.info(TAG, "texts", text);
    // UX-SETUP-08 (approved `tv-step.png`): the shared count at the card's top left, above the title, the bar of the
    // steps under it as on every numbered setup step.
    expect(textOf(one(root, "profile-setup-step"))).toBe("STEP 2 OF 3");
    const card = one(root, "tv-profile-setup-card");
    const bar = card.findAll((node) => node.props.testID === "setup-step-bar" && typeof node.type === "string");
    expect(bar).toHaveLength(1);
    const segments = bar[0]!.findAll((node) => typeof node.type === "string" && node.props.accessibilityElementsHidden === true)[0]!;
    console.info(TAG, "step bar", { segments: segments.children.length });
    expect(segments.children).toHaveLength(3);
    const order = card.findAll((node) => typeof node.type === "string" && (node.props.testID === "profile-setup-step" || node.props.accessibilityRole === "header"));
    expect(order.map((node) => node.props.testID ?? "title")).toEqual(["profile-setup-step", "title"]);
    for (const line of ["Your profile", "How you appear on every app. You can change it later.", "Marie", "Rename on your phone or in Settings", "Back", "Next"]) {
      expect(text).toContain(line);
    }
    // No text field on the TV: the name is renamed elsewhere.
    expect(root.root.findAll((node) => (node.type as unknown) === "TextInput")).toHaveLength(0);

    // The shared TV grid in its setup look: 22 round avatars in six columns, the profile's avatar chosen and focused first.
    const options = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "radio");
    expect(options).toHaveLength(22);
    const grid = one(root, "avatar-chooser");
    const { columns, cell, gap } = TV_AVATAR_GRID_LAYOUT.setup;
    expect(columns).toBe(6);
    // 1080p is twice the 960x540 design screen; the design's 82 px tiles at 1280 wide.
    expect(flatStyle(grid.props.style).width).toBe((6 * cell + 5 * gap) * 2);
    const fox = one(root, "avatar-option-fox");
    expect(fox.props.accessibilityState).toMatchObject({ selected: true });
    expect(fox.props.hasTVPreferredFocus).toBe(true);
    expect(one(root, "avatar-option-owl").props.hasTVPreferredFocus).toBeFalsy();
    // The chosen avatar: amber ring with a gap; focused it grows as drawn.
    expect(flatStyle(fox.props.style)).toMatchObject({ outlineColor: "#ffb357", outlineStyle: "solid" });
    expect(flatStyle(fox.props.style, true).transform).toEqual([{ scale: TV_SETUP_AVATAR_FOCUS_SCALE }]);
    // The big avatar, 90 design dp round (the design's 120 px).
    const preview = one(root, "profile-setup-preview");
    expect(preview.props.source).toBe(sourceOf("fox"));
    expect(flatStyle(preview.props.style)).toMatchObject({ width: TV_PROFILE_SETUP_PREVIEW * 2, height: TV_PROFILE_SETUP_PREVIEW * 2 });
  });

  it("@req UX-SETUP-08[badger-tv] the setup mascot sits half over the card's top border, the card padded under it", () => {
    const root = render(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 2, total: 3 }} onDone={() => undefined} />);
    const mascot = one(root, "profile-setup-mascot");
    const card = flatStyle(one(root, "tv-profile-setup-card").props.style);
    const row = flatStyle(mascot.parent!.parent!.props.style);
    const height = Number(flatStyle(mascot.props.style).height);
    const overlap = Number(row.top) + height - Number(card.top);
    console.info(TAG, "mascot", { rowTop: row.top, height, cardTop: card.top, overlap, cardPaddingTop: card.paddingTop });
    // 1080p: twice the design's 80 dp, its lower part over the card as the phone's mascot is (26 of 84).
    expect(height).toBe(TV_SETUP_MASCOT_SIZE * 2);
    expect(overlap).toBeCloseTo(setupMascotOverlap(TV_SETUP_MASCOT_SIZE) * 2);
    expect(Number(row.top)).toBeGreaterThanOrEqual(0);
    // The step count starts below the mascot, nothing sits under it.
    expect(Number(card.paddingTop)).toBeGreaterThan(overlap);
    expect(row.alignItems).toBe("center");
    expect(card.left).toBe(card.right);
  });

  it("the big avatar follows the remote's focus; OK chooses; leaving the grid shows the chosen one", () => {
    const root = render(<TvProfileSetupScreen profile={marie} onDone={() => undefined} />);
    // Alone (not numbered): no count and no Back without onBack.
    expect(hosts(root, "profile-setup-step")).toHaveLength(0);
    expect(hosts(root, "profile-setup-back")).toHaveLength(0);
    act(() => one(root, "avatar-option-owl").props.onFocus());
    console.info(TAG, "focus owl → preview", one(root, "profile-setup-preview").props.source);
    expect(one(root, "profile-setup-preview").props.source).toBe(sourceOf("owl"));
    expect(one(root, "avatar-option-fox").props.accessibilityState).toMatchObject({ selected: true });
    act(() => one(root, "avatar-option-panda").props.onFocus());
    act(() => one(root, "avatar-option-panda").props.onPress());
    expect(one(root, "avatar-option-panda").props.accessibilityState).toMatchObject({ selected: true });
    act(() => one(root, "avatar-option-owl").props.onFocus());
    expect(one(root, "profile-setup-preview").props.source).toBe(sourceOf("owl"));
    act(() => one(root, "profile-setup-next").props.onFocus());
    expect(one(root, "profile-setup-preview").props.source).toBe(sourceOf("panda"));
  });

  it("the remote's focus starts on the profile's avatar, taken back once from UIKit's first avatar (Apple TV)", () => {
    // Apple TV simulator 2026-11-18: the step opened with the focus on the first avatar (badger), not on Marie's fox.
    vi.useFakeTimers();
    try {
      const requests: string[] = [];
      const createNodeMock = (element: React.ReactElement) => {
        const testID = testIdOf(element);
        return { testID, requestTVFocus: () => requests.push(testID ?? "?") };
      };
      act(() => {
        renderer = create(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 1, total: 2 }} onBack={() => undefined} onDone={() => undefined} />, {
          createNodeMock,
        });
      });
      const root = renderer!;
      expect(one(root, "avatar-option-fox").props.hasTVPreferredFocus).toBe(true);
      expect(requests).toEqual(["avatar-option-fox"]);
      act(() => one(root, "avatar-option-badger").props.onFocus());
      console.info(TAG, "after UIKit's landing on badger", JSON.stringify(requests));
      expect(requests).toEqual(["avatar-option-fox", "avatar-option-fox"]);
      act(() => {
        one(root, "avatar-option-badger").props.onBlur();
        one(root, "avatar-option-fox").props.onFocus();
      });
      // The viewer's own moves after that are left alone, and an avatar holds the focus when the settle time is up.
      act(() => {
        one(root, "avatar-option-fox").props.onBlur();
        one(root, "avatar-option-owl").props.onFocus();
      });
      act(() => {
        vi.advanceTimersByTime(TV_AVATAR_FOCUS_SETTLE_MS);
      });
      expect(requests).toHaveLength(2);
      expect(one(root, "profile-setup-preview").props.source).toBe(sourceOf("owl"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again for the focus when no avatar holds it once the settle time is up", () => {
    vi.useFakeTimers();
    try {
      const requests: string[] = [];
      const createNodeMock = (element: React.ReactElement) => {
        const testID = testIdOf(element);
        return { testID, requestTVFocus: () => requests.push(testID ?? "?") };
      };
      act(() => {
        renderer = create(<TvProfileSetupScreen profile={marie} onDone={() => undefined} />, { createNodeMock });
      });
      act(() => {
        vi.advanceTimersByTime(TV_AVATAR_FOCUS_SETTLE_MS - 1);
      });
      expect(requests).toEqual(["avatar-option-fox"]);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      console.info(TAG, "after the settle time with no avatar focused", JSON.stringify(requests));
      expect(requests).toEqual(["avatar-option-fox", "avatar-option-fox"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Down from any avatar of the last rows lands on Next (the buttons sit under the last columns only)", () => {
    const createNodeMock = (element: React.ReactElement) => ({ testID: testIdOf(element), requestTVFocus: () => undefined });
    act(() => {
      renderer = create(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 1, total: 2 }} onBack={() => undefined} onDone={() => undefined} />, {
        createNodeMock,
      });
    });
    const guide = one(renderer!, "profile-setup-actions");
    expect(guide.type).toBe("TVFocusGuideView");
    const destinations: Array<{ testID?: string }> = guide.props.destinations;
    console.info(TAG, "actions guide destinations", JSON.stringify(destinations));
    expect(destinations.map((view) => view.testID)).toEqual(["profile-setup-next"]);
    // Back and Next are inside the guide, so the arrows still move between them.
    expect(guide.findAll((node) => node.props.testID === "profile-setup-back" && typeof node.type === "string")).toHaveLength(1);
    expect(guide.findAll((node) => node.props.testID === "profile-setup-next" && typeof node.type === "string")).toHaveLength(1);
  });

  it("Next saves the name and the chosen avatar once, marks the numbered step answered, then moves on", async () => {
    const done = vi.fn();
    const root = render(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 2, total: 3 }} onBack={() => undefined} onDone={done} />);
    act(() => one(root, "avatar-option-rocket").props.onPress());
    await press(root, "profile-setup-next");
    console.info(TAG, "saves", JSON.stringify(ctl.saves), "order", ctl.log.join(","));
    expect(ctl.saves).toEqual([{ profileId: "p-marie", change: { name: "Marie", avatarId: "rocket" } }]);
    expect(ctl.log).toEqual(["save", "answered"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("Next with nothing changed still sends the one save; alone it does not touch the setup count", async () => {
    const done = vi.fn();
    const root = render(<TvProfileSetupScreen profile={marie} onDone={done} />);
    await press(root, "profile-setup-next");
    expect(ctl.saves).toEqual([{ profileId: "p-marie", change: { name: "Marie", avatarId: "fox" } }]);
    expect(ctl.answered).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a refused save shows the reason and stays; Back (button and remote) goes back", async () => {
    ctl.saveError = new ProfileActionError("offline");
    const done = vi.fn();
    const back = vi.fn();
    const root = render(<TvProfileSetupScreen profile={marie} stepPosition={{ current: 1, total: 2 }} onBack={back} onDone={done} />);
    await press(root, "profile-setup-next");
    expect(textOf(one(root, "profile-setup-error"))).toBe("No connection. Try again once you're online.");
    expect(done).not.toHaveBeenCalled();
    expect(ctl.answered).toBe(0);
    // Back is the idle ghost button, not dimmed once the save is over.
    expect(flatStyle(one(root, "profile-setup-back").props.style).opacity).toBeUndefined();
    // On the Apple TV the remote's Menu reaches the step (it would leave the app otherwise).
    expect(ctl.menuHolds["tv-profile-setup"]).toBe(true);
    await press(root, "profile-setup-back");
    act(() => {
      expect(ctl.backHandlers.at(-1)!()).toBe(true);
    });
    expect(back).toHaveBeenCalledTimes(2);
  });
});

describe("TvWhatsNewWindow (UX-UPDATE-01)", () => {
  it("draws the desktop window: badge, five avatars, title, the name in bold, Later and the focused main button", () => {
    const root = render(<TvWhatsNewWindow feature="avatars" profileName="Marie" onChoose={() => undefined} onLater={() => undefined} />);
    const text = allText(root);
    console.info(TAG, "window texts", text);
    for (const line of ["New in this update", "Pick an avatar", "Later", "Choose my avatar"]) expect(text).toContain(line);
    expect(textOf(one(root, "whats-new-text"))).toBe("Profiles now have avatars, the same on every app. Choose one for Marie.");
    const bold = one(root, "whats-new-text").findAll((node) => (node.type as unknown) === "Text" && textOf(node) === "Marie");
    expect(bold.length).toBeGreaterThan(0);
    expect(flatStyle(bold.at(-1)!.props.style).fontWeight).toBe("700");
    const art = (["fox", "owl", "panda", "rocket", "octopus"] as const).map((id) => one(root, `whats-new-art-${id}`).props.source);
    expect(art).toEqual(["fox", "owl", "panda", "rocket", "octopus"].map((id) => sourceOf(id as ProfileAvatarId)));
    // The focus starts on the main button and cannot leave the card for the home underneath.
    expect(one(root, "whats-new-choose").props.hasTVPreferredFocus).toBe(true);
    expect(one(root, "whats-new-later").props.hasTVPreferredFocus).toBeFalsy();
    const card = one(root, "tv-whats-new-card");
    expect(card.type).toBe("TVFocusGuideView");
    expect(card.props).toMatchObject({ trapFocusUp: true, trapFocusDown: true, trapFocusLeft: true, trapFocusRight: true });
    expect(flatStyle(one(root, "tv-whats-new").props.style).backgroundColor).toBe("rgba(10, 11, 20, 0.72)");
  });

  it("the main button chooses; Later and the remote's Back answer Later", async () => {
    const choose = vi.fn();
    const later = vi.fn();
    const root = render(<TvWhatsNewWindow feature="avatars" profileName="Marie" onChoose={choose} onLater={later} />);
    await press(root, "whats-new-choose");
    expect(choose).toHaveBeenCalledTimes(1);
    await press(root, "whats-new-later");
    expect(ctl.menuHolds["tv-whats-new"]).toBe(true);
    act(() => {
      expect(ctl.backHandlers.at(-1)!()).toBe(true);
    });
    expect(later).toHaveBeenCalledTimes(2);
  });

  it("keeps the remote's focus in its card: the home under it holding or taking it sends it to the main button", () => {
    vi.useFakeTimers();
    try {
      const requests: string[] = [];
      const createNodeMock = (element: React.ReactElement) => {
        const testID = testIdOf(element);
        return { testID, requestTVFocus: () => requests.push(testID ?? "?") };
      };
      act(() => {
        renderer = create(<TvWhatsNewWindow feature="avatars" profileName="Marie" onChoose={() => undefined} onLater={() => undefined} />, {
          createNodeMock,
        });
      });
      const root = renderer!;
      const advance = (ms: number) =>
        act(() => {
          vi.advanceTimersByTime(ms);
        });
      // The window opened with the focus still on the home: the main button asks for it until it has it.
      advance(TV_WHATS_NEW_HOLD_MS);
      console.info(TAG, "claims before focus", JSON.stringify(requests));
      expect(requests).toEqual(["whats-new-choose"]);
      act(() => one(root, "whats-new-choose").props.onFocus());
      advance(TV_WHATS_NEW_HOLD_MS * 4);
      expect(requests).toHaveLength(1);
      // The viewer moves to Later and back: the focus never left the card.
      act(() => {
        one(root, "whats-new-choose").props.onBlur();
        one(root, "whats-new-later").props.onFocus();
      });
      advance(TV_WHATS_NEW_HOLD_MS * 2);
      expect(requests).toHaveLength(1);
      // A late `hasTVPreferredFocus` on the home takes it out of the card: it comes back to the main button.
      act(() => one(root, "whats-new-later").props.onBlur());
      advance(TV_WHATS_NEW_HOLD_MS);
      console.info(TAG, "claims after the home took the focus", JSON.stringify(requests));
      expect(requests).toEqual(["whats-new-choose", "whats-new-choose"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks French with the name in it", async () => {
    await changeLanguage("fr");
    const root = render(<TvWhatsNewWindow feature="avatars" profileName="Marie" onChoose={() => undefined} onLater={() => undefined} />);
    const text = allText(root);
    console.info(TAG, "fr", text);
    expect(text).toContain("Nouveau dans cette mise à jour");
    expect(text).toContain("Choisir mon avatar");
    expect(text).toContain("Plus tard");
    expect(textOf(one(root, "whats-new-text"))).toBe(
      "Les profils ont maintenant des avatars, les mêmes dans toutes les apps. Choisissez-en un pour Marie.",
    );
  });
});
