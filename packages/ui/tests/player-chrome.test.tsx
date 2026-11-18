import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getNextPlayableEpisode, getPreviousPlayableEpisode, type PlayableSource } from "@space/shared/playableEpisodes";
import { PlayerChrome, type PlayerChromeProps } from "../src/badger/PlayerChrome";

const labels: PlayerChromeProps["labels"] = {
  back: "Close player",
  play: "Play",
  pause: "Pause",
  previousEpisode: "Previous episode",
  nextEpisode: "Next episode",
  seek: "Position",
  volume: "Volume",
  mute: "Mute",
  unmute: "Unmute",
  chapters: "Chapters",
  subtitles: "Subtitles",
  audio: "Audio",
  quality: "Quality",
  fullscreen: "Full screen",
  exitFullscreen: "Exit full screen",
};

const noop = () => {};
const base: PlayerChromeProps = {
  title: "Night Ferry",
  meta: "S1 · E2 “Two” · 2023 · 40m",
  labels,
  visible: true,
  playing: true,
  currentSeconds: 65,
  durationSeconds: 2400,
  volume: 0.8,
  muted: false,
  fullscreen: false,
  onBack: noop,
  onTogglePlay: noop,
  onSeek: noop,
  onVolume: noop,
  onToggleMute: noop,
  onToggleFullscreen: noop,
  menus: {
    subtitles: { items: [{ id: "-1", label: "Off", selected: true }], onSelect: noop },
    audio: { items: [{ id: "0", label: "English", selected: true }], onSelect: noop },
    quality: { items: [{ id: "auto", label: "Auto (1080p)", selected: true }], onSelect: noop },
  },
};

/** Three uploaded episodes of season 1 (picture and sound each), as the library stores them. */
const show = (): PlayableSource => {
  const numbers = [1, 2, 3];
  return {
    type: "tv",
    episodes: numbers.map((n) => ({ id: `ep-${n}`, seasonNumber: 1, episodeNumber: n, name: `E${n}`, overview: null, stillPath: null, airDate: "2023-01-01" })),
    files: numbers.map((n) => ({ id: `file-${n}`, filename: `S01E0${n}.mkv`, season: 1, episode: n, desiredFormats: [] })),
    formats: numbers.map((n) => ({ id: `fmt-${n}`, fileId: `file-${n}`, initKey: `v${n}-init`, chunks: [{ key: `v${n}/c0` }] })),
    audioTracks: numbers.map((n) => ({ id: `aud-${n}`, episodeId: `ep-${n}`, initKey: `a${n}-init`, chunks: [{ key: `a${n}/c0` }] })),
  } as unknown as PlayableSource;
};

/** What the web player passes: a handler only for a neighbour that exists. */
const episodeButtons = (media: PlayableSource, episodeId: string | null) => {
  const previous = getPreviousPlayableEpisode(media, episodeId);
  const next = getNextPlayableEpisode(media, episodeId);
  const html = renderToStaticMarkup(
    <PlayerChrome {...base} onPreviousEpisode={previous ? noop : undefined} onNextEpisode={next ? noop : undefined} />
  );
  const shown = { previous: html.includes('data-testid="player-chrome-previous-episode"'), next: html.includes('data-testid="player-chrome-next-episode"') };
  console.info("[player-chrome] episode buttons", { episodeId, previous: previous?.id ?? null, next: next?.id ?? null, shown });
  return shown;
};

// @req MPV-OSC-04[badger-web-player]
// @req PLAY-OVL-03[badger-web-player]
describe("[player-chrome] previous / next episode beside play / pause", () => {
  it("first episode: next only", () => {
    expect(episodeButtons(show(), "ep-1")).toEqual({ previous: false, next: true });
  });

  it("middle episode: both", () => {
    expect(episodeButtons(show(), "ep-2")).toEqual({ previous: true, next: true });
  });

  it("last uploaded episode: previous only", () => {
    expect(episodeButtons(show(), "ep-3")).toEqual({ previous: true, next: false });
  });

  it("film: neither", () => {
    expect(episodeButtons({ ...show(), type: "movie" }, null)).toEqual({ previous: false, next: false });
  });
});

// @req MPV-OSC-04[badger-web-player]
describe("[player-chrome] layout", () => {
  it("draws the back arrow, title, meta line, both times and the play / pause label", () => {
    const html = renderToStaticMarkup(<PlayerChrome {...base} />);
    expect(html).toContain('aria-label="Close player"');
    expect(html).toContain("Night Ferry");
    expect(html).toContain("S1 · E2 “Two” · 2023 · 40m");
    expect(html).toContain('aria-label="Pause"');
    expect(renderToStaticMarkup(<PlayerChrome {...base} playing={false} />)).toContain('aria-label="Play"');
    expect(html).toMatch(/data-testid="player-chrome-time"[^>]*>1:05</);
    expect(html).toMatch(/data-testid="player-chrome-duration"[^>]*>40:00</);
  });

  it("shows the Chapters chip only with a chapters menu, before subtitles, audio, quality and full screen", () => {
    expect(renderToStaticMarkup(<PlayerChrome {...base} />)).not.toContain("player-chrome-chapters");
    const html = renderToStaticMarkup(
      <PlayerChrome {...base} menus={{ ...base.menus, chapters: { items: [{ id: "0", label: "Opening (0:00)", selected: true }], onSelect: noop } }} />
    );
    const order = ["chapters", "subtitles", "audio", "quality", "fullscreen"].map((id) => html.indexOf(`data-testid="player-chrome-${id}"`));
    console.info("[player-chrome] chip order", order);
    expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]))).toBe(true);
  });

  // @req PLAY-OVL-05[badger-web-player]
  it("[PLAY-OVL-05] the subtitles chip draws the captions icon (text lines), not CC", () => {
    const html = renderToStaticMarkup(<PlayerChrome {...base} />);
    const chip = html.slice(html.indexOf('data-testid="player-chrome-subtitles"'), html.indexOf('data-testid="player-chrome-audio"'));
    console.info("[player-chrome] subtitles chip", chip.slice(0, 400));
    expect(chip).toContain("lucide-captions");
    expect(chip).not.toContain("lucide-closed-caption");
  });

  it("hides the controls when idle while playing, keeping the picture clickable", () => {
    const html = renderToStaticMarkup(<PlayerChrome {...base} visible={false} />);
    expect(html).toContain('data-visible="false"');
    expect(html).toContain("opacity-0");
  });
});

// @req PLAY-LOOK-01[badger-web-player]
describe("[player-chrome] Badger yellow", () => {
  it("paints the played part and thumb of the seek and volume bars in --primary, the unplayed part white at 0.25", () => {
    const html = renderToStaticMarkup(<PlayerChrome {...base} />);
    const yellow = html.match(/bg-primary/g)?.length ?? 0;
    const unplayed = html.match(/bg-white\/25/g)?.length ?? 0;
    console.info("[player-chrome] bar colours", { yellow, unplayed });
    // Seek and volume: one played part and one thumb each.
    expect(yellow).toBeGreaterThanOrEqual(4);
    expect(unplayed).toBe(2);
  });
});
