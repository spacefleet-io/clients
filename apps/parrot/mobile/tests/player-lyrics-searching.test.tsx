/**
 * @test-id PARROT-MOBILE-LYRICS-SEARCHING-001
 * @level unit
 * @req PAR-LYR-06[parrot]
 * @req PAR-LYR-05[parrot]
 * @req PAR-COPY-01[parrot]
 * @why Chris 2026-11-13: Parrot must never say "No lyrics" or "No lyrics yet" while a lyrics lookup for the song is
 *   queued or running. The phone's Lyrics sheet shows "Looking for lyrics…" with a spinner while the automatic pass
 *   has the song pending (`lyricsPending`) and while "Search again" runs, also for a song kept as "No lyrics"; the
 *   final "No lyrics" shows only once the lookup answered with none. Chris 2026-11-16 (PAR-LYR-05): a playing song never
 *   looked up is asked for at once, and "Search again" shows only after a lookup came back empty or failed, never
 *   while one is on its way. Chris 2026-11-16 (PAR-COPY-01): the sheet never asks the metadata service on its own; it
 *   hands the song to the paced automatic pass (`wantLyrics`) and shows what the pass kept in the library. The real
 *   PlayerLyrics is mounted against a mocked React Native; the library reads are faked, the pending set is the real
 *   shared one of @space/parrot-core.
 * @covers apps/parrot/mobile/src/screens/PlayerLyrics.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_EN } from "@space/parrot-core/shell-strings";
import type * as ParrotCore from "@space/parrot-core";
import type { ParrotLyrics } from "@space/parrot-core";

const TEST_ID = "PARROT-MOBILE-LYRICS-SEARCHING-001";
const log = (phase: string, detail: unknown = {}) => console.info(`[${TEST_ID}] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  stored: new Map<string, ParrotLyrics | null>(),
  fetches: [] as { trackId: string; resolve: (result: { outcome: "found" | "none"; lyrics: ParrotLyrics | null }) => void }[],
  /** Songs the sheet handed to the automatic pass (the session's `wantLyrics`). */
  wants: [] as string[],
  version: 1,
  /** When set, library reads wait for it, as a slow SQLite read after a save. */
  readGate: null as PromiseWithResolvers<void> | null,
  /** When set, the next lyrics lookup ends as this promise does (a failure rejects it). */
  fail: null as Promise<never> | null,
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
    Pressable: (props: Record<string, unknown>) =>
      react.createElement("Pressable", props, typeof props.children === "function" ? null : (props.children as React.ReactNode)),
    ScrollView: host("ScrollView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    Text: host("Text"),
    View: host("View"),
  };
});
vi.mock("lucide-react-native", () => ({ Mic: "Icon:Mic", Pencil: "Icon:Pencil", Trash2: "Icon:Trash2" }));
// The editor is covered by player-own-lyrics.test.tsx; here it stays closed.
vi.mock("../src/screens/LyricsEditor", () => ({ LyricsEditor: () => null }));
// The lyrics scroll in the shared sheet's scroll view (UX-SHEET-01); here it is a plain ScrollView.
vi.mock("@space/mobile-shell/bottom-sheet", async () => {
  const react = await vi.importActual<typeof React>("react");
  return {
    MobileSheetScrollView: (props: Record<string, unknown>) =>
      react.createElement("ScrollView", props, props.children as React.ReactNode),
  };
});
vi.mock("@space/mobile-audio-playback", () => ({ AudioPlayback: { seekTo: async () => undefined } }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith("shell.") ? ((SHELL_EN as Record<string, string>)[key.slice("shell.".length)] ?? key) : key),
  }),
}));
vi.mock("../src/state/session", async () => {
  // A hoisted mock factory runs before the file's imports: it reaches the (mocked) library module through import().
  const { lyricsPending } = await import("../src/lib/library");
  return {
    useSession: () => ({
      library: { status: "ready", error: null, version: fake.version },
      // The session's real `wantLyrics` holds the song in `lyricsPending` and starts the pass; the pass is played by hand here.
      wantLyrics: (trackId: string) => {
        fake.wants.push(trackId);
        lyricsPending.want(trackId);
      },
    }),
  };
});
vi.mock("../src/lib/lookup", () => ({ lookupClient: async () => ({ musicLyrics: async () => ({ plain: null, synced: null }) }) }));
vi.mock("../src/lib/library", async () => {
  const { createParrotLyricsPending } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  return {
    lyricsPending: createParrotLyricsPending(),
    readTrackLyrics: async (trackId: string) => {
      const gate = fake.readGate;
      if (gate) await gate.promise;
      return fake.stored.get(trackId) ?? null;
    },
    fetchTrackLyrics: (trackId: string) => {
      const { promise, resolve } = Promise.withResolvers<{ outcome: "found" | "none"; lyrics: ParrotLyrics | null }>();
      fake.fetches.push({ trackId, resolve });
      const failing = fake.fail;
      fake.fail = null;
      return failing ?? promise;
    },
  };
});

import { PlayerLyrics } from "../src/screens/PlayerLyrics";
import { lyricsPending } from "../src/lib/library";

let tree: ReactTestRenderer;
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await act(async () => undefined);
};
const byTestId = (id: string): ReactTestInstance | undefined => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const texts = () =>
  tree.root
    .findAll((node) => (node.type as unknown) === "Text")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join(" | ");
const mount = async (trackId: string) => {
  await act(async () => {
    tree = create(<PlayerLyrics trackId={trackId} title="Song" positionMs={0} playing={false} />);
  });
  await settle();
};
const rerender = async (trackId: string) => {
  await act(async () => tree.update(<PlayerLyrics trackId={trackId} title="Song" positionMs={0} playing={false} />));
  await settle();
};
const expectSearching = (where: string) => {
  const shown = texts();
  log(where, { shown, searching: Boolean(byTestId("lyrics-searching")), none: Boolean(byTestId("lyrics-none")) });
  expect(byTestId("lyrics-searching"), where).toBeTruthy();
  expect(byTestId("lyrics-none"), where).toBeUndefined();
  expect(shown).toContain(SHELL_EN["nowPlaying.searchingLyricsTitle"]);
  expect(shown).not.toContain(SHELL_EN["nowPlaying.noLyricsTitle"]);
  expect(shown).not.toContain(SHELL_EN["nowPlaying.noLyricsFoundTitle"]);
};

beforeEach(() => {
  fake.stored.clear();
  fake.fetches = [];
  fake.wants = [];
  fake.version = 1;
  fake.readGate = null;
  fake.fail = null;
});
afterEach(() => {
  act(() => tree.unmount());
  lyricsPending.clear();
});

describe(`${TEST_ID} the phone's Lyrics sheet while a lookup runs`, () => {
  it("a song the automatic pass has queued says 'Looking for lyrics…', then the final 'No lyrics' once it answered none", async () => {
    const pass = lyricsPending.hold(["t-fable"]);
    await mount("t-fable");
    expectSearching("auto pending");

    log("pass answers none and keeps it");
    fake.stored.set("t-fable", { synced: null, plain: null, fetched: true, notFound: true });
    fake.version = 2;
    await act(async () => pass.release());
    await rerender("t-fable");
    log("after", { shown: texts() });
    expect(byTestId("lyrics-searching")).toBeUndefined();
    expect(byTestId("lyrics-none")).toBeTruthy();
    expect(texts()).toContain(SHELL_EN["nowPlaying.noLyricsFoundTitle"]);
    expect(texts()).toContain(SHELL_EN["nowPlaying.noLyricsFoundBody"]);
  });

  it("a song kept as 'No lyrics' that the user asks again says 'Looking for lyrics…' until the answer, then 'No lyrics'", async () => {
    fake.stored.set("t-fable", { synced: null, plain: null, fetched: true, notFound: true });
    await mount("t-fable");
    expect(texts()).toContain(SHELL_EN["nowPlaying.noLyricsFoundTitle"]);
    await act(async () => byTestId("lyrics-fetch")!.props.onPress());
    await settle();
    expect(fake.fetches.map((fetch) => fetch.trackId)).toEqual(["t-fable"]);
    expectSearching("fetch busy");

    log("fetch answers none");
    await act(async () => fake.fetches[0]!.resolve({ outcome: "none", lyrics: null }));
    await settle();
    log("after", { shown: texts() });
    expect(byTestId("lyrics-searching")).toBeUndefined();
    expect(texts()).toContain(SHELL_EN["nowPlaying.noLyricsFoundTitle"]);
    expect(byTestId("lyrics-fetch"), "Search again after an empty answer").toBeTruthy();
  });

  it("right after the pass lets go, it stays on 'Looking for lyrics…' until the re-read returns, never flashing 'No lyrics yet'", async () => {
    const pass = lyricsPending.hold(["t-fable"]);
    await mount("t-fable");
    expectSearching("auto pending");

    log("pass keeps none and lets go; the library re-read is slow");
    fake.readGate = Promise.withResolvers<void>();
    fake.stored.set("t-fable", { synced: null, plain: null, fetched: true, notFound: true });
    await act(async () => pass.release());
    await settle();
    expect(byTestId("lyrics-fetch"), "no Fetch before the re-read").toBeUndefined();
    expectSearching("settled, re-read pending");

    log("re-read returns");
    await act(async () => fake.readGate!.resolve());
    await settle();
    log("after", { shown: texts() });
    expect(byTestId("lyrics-searching")).toBeUndefined();
    expect(texts()).toContain(SHELL_EN["nowPlaying.noLyricsFoundTitle"]);
  });

  it("PAR-LYR-05 / PAR-COPY-01: a song never looked up goes to the automatic pass at once, says 'Looking for lyrics…' without Search again, and is handed once", async () => {
    await mount("t-nook");
    log("handed on open", { wants: fake.wants, fetches: fake.fetches.map((fetch) => fetch.trackId), shown: texts() });
    // PAR-COPY-01: no lookup from the sheet itself.
    expect(fake.fetches).toEqual([]);
    expect(fake.wants).toEqual(["t-nook"]);
    expectSearching("never looked up, handed to the pass");
    expect(byTestId("lyrics-fetch"), "no Search again while loading").toBeUndefined();

    log("the pass finds the words and keeps them in the library");
    fake.stored.set("t-nook", { synced: null, plain: "I'm tired", fetched: true });
    await act(async () => lyricsPending.takeWanted()!.hold.release());
    await settle();
    log("after the pass", { shown: texts(), wants: fake.wants });
    expect(byTestId("lyrics-plain")).toBeTruthy();
    expect(fake.wants).toEqual(["t-nook"]);
    expect(fake.fetches).toEqual([]);
  });

  it("PAR-LYR-05: a song whose automatic ask failed says why, with Search again", async () => {
    await mount("t-nook");
    expectSearching("asking");
    expect(byTestId("lyrics-fetch")).toBeUndefined();
    log("the pass lets go with no answer (lookup failed)");
    await act(async () => lyricsPending.takeWanted()!.hold.release());
    await settle();
    log("failed", { shown: texts() });
    expect(byTestId("lyrics-searching")).toBeUndefined();
    expect(texts()).toContain(SHELL_EN["nowPlaying.fetchLyricsFailed"]);
    expect(byTestId("lyrics-fetch"), "Search again after a failure").toBeTruthy();
    expect(fake.wants).toEqual(["t-nook"]); // not handed again on its own
    expect(fake.fetches).toEqual([]);
  });
});
