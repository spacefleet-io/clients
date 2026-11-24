/**
 * @test-id PARROT-MOBILE-ROW-PLAY-001
 * @level unit
 * @req PAR-PLAY-10[parrot]
 * @why Chris, 2026-11-24: a tap on a song row does what its play button does. On the phone the whole row already
 *   played the song, but on the song playing now it started it again from the top; it now pauses or resumes it, read
 *   from the player at the tap. The "more" button keeps opening the song sheet and never touches playback, and a long
 *   press still opens the sheet. The row is named "Pause {title}" on the song playing, in every language. The row is
 *   called as a function against a mocked React Native and a mocked native player.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const player = vi.hoisted(() => ({
  state: { mediaId: "t2", playWhenReady: true, suppressed: false, state: "ready" as string },
  calls: [] as string[],
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-ROW-PLAY-001] ${step}`, JSON.stringify(detail));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ Ellipsis: "Icon:Ellipsis" }));
vi.mock("../src/screens/equalizer", () => ({ ParrotEqualizer: "ParrotEqualizer" }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    getState: async () => {
      player.calls.push("getState");
      return player.state;
    },
    pause: async () => void player.calls.push("pause"),
    play: async () => void player.calls.push("play"),
    onState: () => ({ remove: () => undefined }),
  },
  showsPause: (s: { playWhenReady: boolean; suppressed: boolean; state: string }) => s.playWhenReady && !s.suppressed && s.state !== "ended",
}));

import { SongListRow } from "../src/screens/SongListRow";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};
/** Lets the tap's player calls (async) run before the test reads them. */
const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

describe("a tap on a song row (PAR-PLAY-10)", () => {
  let played: number;
  let sheets: number;
  const row = (playing: { animated: boolean } | null) =>
    SongListRow({
      lead: 2,
      title: "Lantern",
      durationMs: 200_000,
      playing,
      starting: false,
      disabled: false,
      accessibilityLabel: playing?.animated ? "Pause Lantern" : "Play Lantern",
      onPress: () => void (played += 1),
      onMore: () => void (sheets += 1),
      moreLabel: "More, Lantern",
    }) as unknown as Element;

  beforeEach(() => {
    played = 0;
    sheets = 0;
    player.calls = [];
    player.state = { mediaId: "t2", playWhenReady: true, suppressed: false, state: "ready" };
  });

  it("on another song, the whole row plays it from its list", async () => {
    const other = row(null);
    log("row", { testID: other.props.testID, role: other.props.accessibilityRole, label: other.props.accessibilityLabel });
    expect(other.props.accessibilityRole).toBe("button");
    (other.props.onPress as () => void)();
    await settle();
    log("tap", { played, player: player.calls });
    expect(played).toBe(1);
    expect(player.calls).toEqual([]);
  });

  it("on the song playing now, it pauses instead of starting the song again", async () => {
    const current = row({ animated: true });
    expect(current.props.testID).toBe("song-row-playing");
    expect(current.props.accessibilityLabel).toBe("Pause Lantern");
    (current.props.onPress as () => void)();
    await settle();
    log("tap playing", { played, player: player.calls });
    expect(player.calls).toEqual(["getState", "pause"]);
    expect(played).toBe(0);
  });

  it("on the song paused now, it resumes it, read from the player at the tap", async () => {
    player.state = { ...player.state, playWhenReady: false };
    (row({ animated: true }).props.onPress as () => void)();
    await settle();
    log("tap paused", { played, player: player.calls });
    expect(player.calls).toEqual(["getState", "play"]);
    expect(played).toBe(0);
  });

  it("the more button and a long press open the song sheet and never touch playback", async () => {
    const current = row({ animated: true });
    const more = all(current, (el) => el.props?.testID === "song-more")[0]!;
    (more.props.onPress as () => void)();
    (current.props.onLongPress as () => void)();
    await settle();
    log("more and long press", { sheets, played, player: player.calls });
    expect(sheets).toBe(2);
    expect(played).toBe(0);
    expect(player.calls).toEqual([]);
  });

  it("every language names the playing row's tap as a pause", () => {
    const names = Object.fromEntries(
      ["en", "fr", "nl", "de", "es"].map((lang) => {
        const strings = JSON.parse(readFileSync(resolve(__dirname, `../src/i18n/${lang}.json`), "utf8")) as { parrot: { album: Record<string, string> } };
        return [lang, { play: strings.parrot.album.play, pause: strings.parrot.album.pause }];
      })
    );
    log("labels", names);
    for (const { play, pause } of Object.values(names)) {
      expect(play).toContain("{{title}}");
      expect(pause).toContain("{{title}}");
      expect(pause).not.toBe(play);
    }
  });
});
