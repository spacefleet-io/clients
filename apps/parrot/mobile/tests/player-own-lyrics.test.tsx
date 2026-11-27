/**
 * @test-id PARROT-MOBILE-OWN-LYRICS-001
 * @level unit
 * @req PAR-LYR-08[parrot]
 * @req PAR-LYR-10[parrot]
 * @req PAR-LYR-11[parrot]
 * @why Chris 2026-11-27: a song Parrot finds no lyrics for must not be left without any; the user adds their own from
 *   a tool with no special file. On the phone the Lyrics sheet offers "Add lyrics" under "No lyrics" and "Edit lyrics"
 *   under words; the editor is two full pages (Chris 2026-11-27): the words page takes pasted words and "Save the
 *   words" keeps them plain; "Time the lyrics" opens the timing page, where Tap at the player's position times each
 *   line and Save keeps synced lyrics; Back returns to the words with the times kept. The user's own lyrics say so ("Your synced lyrics") and can be removed. The
 *   real PlayerLyrics and LyricsEditor are mounted against a mocked React Native; the library save is faked. The
 *   editor stays on the song it was opened for when the next song starts (a phone run lost the typed words there).
 * @covers apps/parrot/mobile/src/screens/PlayerLyrics.tsx
 * @covers apps/parrot/mobile/src/screens/LyricsEditor.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_EN } from "@space/parrot-core/shell-strings";
import type * as ParrotCore from "@space/parrot-core";
import type { ParrotLyrics, ParrotOwnLyrics } from "@space/parrot-core";

const TEST_ID = "PARROT-MOBILE-OWN-LYRICS-001";
const log = (phase: string, detail: unknown = {}) => console.info(`[${TEST_ID}] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  stored: new Map<string, ParrotLyrics | null>(),
  saves: [] as { trackId: string; lyrics: ParrotOwnLyrics | null }[],
  positionMs: 0,
  played: 0,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof React>("react");
  return { ...actual, default: actual };
});
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof React>("react");
  const host = (name: string) => (props: Record<string, unknown>) => react.createElement(name, props, props.children as React.ReactNode);
  return {
    ActivityIndicator: host("ActivityIndicator"),
    Modal: (props: Record<string, unknown>) => (props.visible ? react.createElement("Modal", props, props.children as React.ReactNode) : null),
    Pressable: (props: Record<string, unknown>) =>
      react.createElement("Pressable", props, typeof props.children === "function" ? null : (props.children as React.ReactNode)),
    ScrollView: host("ScrollView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    Text: host("Text"),
    TextInput: host("TextInput"),
    View: host("View"),
  };
});
vi.mock("lucide-react-native", () => ({ Mic: "Icon:Mic", Pencil: "Icon:Pencil", Trash2: "Icon:Trash2", Minus: "Icon:Minus", Plus: "Icon:Plus" }));
vi.mock("@space/mobile-shell/components", () => ({ MobileButton: "MobileButton", MobileIconButton: "MobileIconButton" }));
vi.mock("@space/mobile-shell/bottom-sheet", async () => {
  const react = await vi.importActual<typeof React>("react");
  return { MobileSheetScrollView: (props: Record<string, unknown>) => react.createElement("ScrollView", props, props.children as React.ReactNode) };
});
vi.mock("@space/mobile-shell/keyboard", async () => {
  const react = await vi.importActual<typeof React>("react");
  return {
    KeyboardAvoidingForm: (props: Record<string, unknown>) => react.createElement("View", props, props.children as React.ReactNode),
    useKeyboardOpen: () => false,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ MobileRenderBoundary: (props: { children: React.ReactNode }) => props.children }));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    seekTo: async () => undefined,
    play: async () => {
      fake.played += 1;
    },
    pause: async () => undefined,
    getState: async () => ({ positionMs: fake.positionMs }),
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    // SHELL_EN holds `{x}` placeholders; the phone's i18n fills them the same way.
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text = key.startsWith("shell.") ? ((SHELL_EN as Record<string, string>)[key.slice("shell.".length)] ?? key) : key;
      return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
    },
  }),
}));
vi.mock("../src/state/session", () => ({
  useSession: () => ({ library: { status: "ready", error: null, version: 1 }, wantLyrics: () => undefined }),
}));
vi.mock("../src/lib/lookup", () => ({ lookupClient: async () => ({ musicLyrics: async () => ({ plain: null, synced: null }) }) }));
vi.mock("../src/lib/library", async () => {
  const { createParrotLyricsPending } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  return {
    lyricsPending: createParrotLyricsPending(),
    readTrackLyrics: async (trackId: string) => fake.stored.get(trackId) ?? null,
    fetchTrackLyrics: async () => ({ outcome: "none", lyrics: null }),
    saveOwnLyrics: async (trackId: string, lyrics: ParrotOwnLyrics | null) => {
      fake.saves.push({ trackId, lyrics });
      const saved: ParrotLyrics | null = lyrics ? { synced: lyrics.synced ? [...lyrics.synced] : null, plain: lyrics.plain, fetched: true, own: true } : null;
      fake.stored.set(trackId, saved);
      return saved;
    },
  };
});

import { PlayerLyrics } from "../src/screens/PlayerLyrics";

let tree: ReactTestRenderer;
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await act(async () => undefined);
};
const byTestId = (id: string): ReactTestInstance | undefined => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const allByTestId = (id: string) => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const texts = () =>
  tree.root
    .findAll((node) => (node.type as unknown) === "Text")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join(" | ");
const press = async (id: string) => {
  const node = byTestId(id);
  expect(node, id).toBeTruthy();
  await act(async () => (node!.props.onPress as () => void)());
  await settle();
};
const mount = async (trackId: string) => {
  await act(async () => {
    tree = create(<PlayerLyrics trackId={trackId} title="Fable" positionMs={0} playing={false} />);
  });
  await settle();
};

beforeEach(() => {
  fake.stored.clear();
  fake.saves = [];
  fake.positionMs = 0;
  fake.played = 0;
});
afterEach(() => {
  act(() => tree.unmount());
});

describe(`${TEST_ID} the user's own lyrics on the phone`, () => {
  it("'No lyrics' offers 'Add lyrics'; pasted words save as the user's plain lyrics and replace 'No lyrics'", async () => {
    fake.stored.set("t-fable", { synced: null, plain: null, fetched: true, notFound: true });
    await mount("t-fable");
    log("none", { shown: texts() });
    expect(byTestId("lyrics-none")).toBeTruthy();
    expect(byTestId("lyrics-add")).toBeTruthy();
    expect(byTestId("lyrics-remove")).toBeUndefined();

    await press("lyrics-add");
    expect(byTestId("lyrics-editor")).toBeTruthy();
    expect(texts()).toContain("Lyrics for Fable");
    await act(async () => (byTestId("lyrics-editor-text")!.props.onChangeText as (text: string) => void)("First line\nSecond line"));
    await press("lyrics-editor-save-words");
    log("saved", { saves: fake.saves, shown: texts() });

    expect(fake.saves).toEqual([{ trackId: "t-fable", lyrics: { synced: null, plain: "First line\nSecond line" } }]);
    expect(byTestId("lyrics-editor")).toBeUndefined();
    expect(byTestId("lyrics-plain")).toBeTruthy();
    expect(texts()).toContain(SHELL_EN["nowPlaying.ownPlainLyricsSource"]);
    expect(byTestId("lyrics-edit")).toBeTruthy();
    expect(byTestId("lyrics-remove")).toBeTruthy();
  });

  it("the timing page taps each line at the player's position and saves synced lyrics", async () => {
    fake.stored.set("t-fable", { synced: null, plain: "First line\nSecond line", fetched: true });
    await mount("t-fable");
    log("found plain", { shown: texts() });
    // Lyrics found elsewhere can be edited, not removed (PAR-LYR-11).
    expect(byTestId("lyrics-remove")).toBeUndefined();

    await press("lyrics-edit");
    await press("lyrics-editor-time");
    expect(byTestId("lyrics-editor-timing")).toBeTruthy();
    expect(byTestId("lyrics-editor")).toBeUndefined();
    expect(allByTestId("lyrics-editor-line")).toHaveLength(2);
    // A phone has no Space key: the hint names only tapping (PAR-LYR-10, Space is the desktop's).
    expect(texts()).toContain("Play the song and tap as each line starts. If a line has no time, the lyrics are saved without timing.");
    expect(texts()).not.toContain("Space");

    fake.positionMs = 1_000;
    await press("lyrics-editor-tap");
    expect(texts()).toContain("1 of 2 lines timed");

    log("Back returns to the words page and keeps the time; timing again starts from it");
    await press("lyrics-editor-back");
    expect(byTestId("lyrics-editor-timing")).toBeUndefined();
    log("words page", { text: byTestId("lyrics-editor-text")!.props.value });
    expect(byTestId("lyrics-editor-text")!.props.value).toContain("Second line");
    await press("lyrics-editor-time");
    expect(texts()).toContain("1 of 2 lines timed");

    log("a second line timed before the first is refused, never reordered");
    fake.positionMs = 500;
    await press("lyrics-editor-tap");
    await press("lyrics-editor-save");
    log("refused", { shown: texts() });
    expect(fake.saves).toEqual([]);
    expect(byTestId("lyrics-editor-problem")).toBeTruthy();

    log("the refused line is selected: tap it again, nudge it later, replay it");
    fake.positionMs = 4_200;
    await press("lyrics-editor-tap");
    await press("lyrics-editor-later");
    await press("lyrics-editor-replay");
    expect(fake.played).toBe(1);
    expect(texts()).toContain("2 of 2 lines timed");

    await press("lyrics-editor-save");
    log("saved", { saves: fake.saves, shown: texts() });
    expect(fake.saves).toEqual([
      {
        trackId: "t-fable",
        lyrics: {
          synced: [
            { ms: 1_000, text: "First line" },
            { ms: 4_300, text: "Second line" },
          ],
          plain: "First line\nSecond line",
        },
      },
    ]);
    expect(texts()).toContain(SHELL_EN["nowPlaying.ownSyncedLyricsSource"]);
  });

  it("'Remove my lyrics' takes the user's own away", async () => {
    fake.stored.set("t-fable", { synced: null, plain: "Mine", fetched: true, own: true });
    await mount("t-fable");
    expect(texts()).toContain(SHELL_EN["nowPlaying.ownPlainLyricsSource"]);
    await press("lyrics-remove");
    log("removed", { saves: fake.saves, shown: texts() });
    expect(fake.saves).toEqual([{ trackId: "t-fable", lyrics: null }]);
    expect(byTestId("lyrics-plain")).toBeUndefined();
    expect(byTestId("lyrics-remove")).toBeUndefined();
  });

  it("the editor stays on its song when the next one starts: the words are kept and saved to the song it was opened for", async () => {
    fake.stored.set("t-fable", { synced: null, plain: null, fetched: true, notFound: true });
    fake.stored.set("t-next", { synced: null, plain: "Next words", fetched: true });
    await mount("t-fable");
    await press("lyrics-add");
    await act(async () => (byTestId("lyrics-editor-text")!.props.onChangeText as (text: string) => void)("Mine"));

    log("the song ends and the next one starts while the editor is open");
    await act(async () => tree.update(<PlayerLyrics trackId="t-next" title="Next" positionMs={0} playing />));
    await settle();
    log("next song", { shown: texts() });
    expect(byTestId("lyrics-editor")).toBeTruthy();
    expect(texts()).toContain("Lyrics for Fable");
    expect(byTestId("lyrics-editor-text")!.props.value).toBe("Mine");

    await press("lyrics-editor-save-words");
    log("saved", { saves: fake.saves, shown: texts() });
    expect(fake.saves).toEqual([{ trackId: "t-fable", lyrics: { synced: null, plain: "Mine" } }]);
    expect(byTestId("lyrics-editor")).toBeUndefined();
    // The sheet goes on showing the song playing now, not the one just saved.
    expect(byTestId("lyrics-plain")).toBeTruthy();
    expect(texts()).toContain("Next words");
    expect(byTestId("lyrics-remove")).toBeUndefined();
  });
});
