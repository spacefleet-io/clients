// @vitest-environment jsdom
/**
 * The Lyrics tab's words (PAR-LYR-01, PAR-LYR-04, PAR-LYR-05, PAR-LYR-06), shared by Parrot web and desktop:
 *   - synced lyrics light the line being sung, dim the sung ones, and a click on a line plays from there;
 *   - plain lyrics show as written; a song with none says "No lyrics yet";
 *   - fetched lyrics say Parrot found them, never where; a song with none is looked up on its own, and "Search again" shows only after a lookup came back empty or failed;
 *   - while a lookup for the song is queued or running, "Looking for lyrics…", never "No lyrics yet" or "No lyrics".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ParrotLyricsPane } from "../src/parrot/screens";

const labels = {
  lyrics: "Lyrics",
  queue: "Up next",
  about: "About",
  noLyricsTitle: "No lyrics yet",
  noLyricsBody: "This song's file has no lyrics.",
  searchingLyricsTitle: "Looking for lyrics…",
  searchingLyricsBody: "Parrot is looking for this song's lyrics.",
  syncedLyricsSource: "Synced lyrics from your file",
  plainLyricsSource: "Lyrics from your file",
  fetchedSyncedLyricsSource: "Synced lyrics found by Parrot",
  fetchedPlainLyricsSource: "Lyrics found by Parrot",
  nothingNext: "Nothing else in the queue.",
  nowPlaying: "Now playing",
  aboutRows: [],
};
const synced = {
  synced: [
    { ms: 0, text: "First line" },
    { ms: 5000, text: "Second line" },
    { ms: 10000, text: "Third line" },
  ],
  plain: null,
  fetched: false,
};

// @req PAR-LYR-01[parrot]
// @req PAR-LYR-04[parrot]
describe("[parrot] lyrics pane", () => {
  it("lights the line being sung: past lines before it, next lines after it", () => {
    const html = renderToStaticMarkup(<ParrotLyricsPane lyrics={synced} positionMs={6000} labels={labels} />);
    const states = [...html.matchAll(/data-state="(\w+)"/g)].map((m) => m[1]);
    console.info("[parrot-lyrics] states at 6s", states);
    expect(states).toEqual(["past", "now", "next"]);
    expect(html).toContain("Synced lyrics from your file");
  });

  it("plays from a line when it is clicked", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const onSeek = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ParrotLyricsPane lyrics={synced} positionMs={0} onSeek={onSeek} labels={labels} />));
    const lines = host.querySelectorAll<HTMLElement>('[data-testid="lyrics-line"]');
    await act(async () => lines[2]!.click());
    console.info("[parrot-lyrics] seek calls", onSeek.mock.calls);
    expect(onSeek).toHaveBeenCalledWith(10000);
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows plain lyrics as written, and says plainly when a song has none", () => {
    const plain = renderToStaticMarkup(<ParrotLyricsPane lyrics={{ synced: null, plain: "Words\nMore words", fetched: false }} positionMs={0} labels={labels} />);
    const none = renderToStaticMarkup(<ParrotLyricsPane lyrics={null} positionMs={0} labels={labels} />);
    expect(plain).toContain('data-testid="lyrics-plain"');
    expect(plain).toContain("Lyrics from your file");
    expect(none).toContain('data-testid="lyrics-none"');
    expect(none).toContain("No lyrics yet");
  });
});

const fetchLabels = { body: "Parrot looks for them on its own.", button: "Search again", none: "No lyrics found for this song.", failed: "Couldn't fetch lyrics." };

// @req PAR-LYR-05[parrot]
// @req PAR-META-20[parrot]
describe("[parrot] fetch lyrics", () => {
  it("says Parrot found the fetched lyrics, without naming where", () => {
    const html = renderToStaticMarkup(<ParrotLyricsPane lyrics={{ synced: null, plain: "Words", fetched: true }} positionMs={0} labels={labels} />);
    expect(html).toContain("Lyrics found by Parrot");
    expect(html).not.toContain("Lyrics from your file");
  });

  it("asks on its own (no button) while idle or searching, and offers Search again only after none or failed", async () => {
    const render = (state: "idle" | "busy" | "none" | "failed", onFetch = () => {}) =>
      renderToStaticMarkup(<ParrotLyricsPane lyrics={null} positionMs={0} labels={labels} fetchLyrics={{ state, onFetch, labels: fetchLabels }} />);
    const idle = render("idle");
    console.info("[parrot-lyrics] idle", idle);
    expect(idle).not.toContain('data-testid="lyrics-fetch"');
    expect(idle).toContain("Parrot looks for them on its own.");
    const busy = render("busy");
    console.info("[parrot-lyrics] busy", busy);
    expect(busy).toContain('data-testid="lyrics-searching"');
    expect(busy).toContain("Looking for lyrics…");
    expect(busy).not.toContain('data-testid="lyrics-fetch"');
    const none = render("none");
    console.info("[parrot-lyrics] none", none);
    expect(none).toContain('data-testid="lyrics-fetch"');
    expect(none).toContain("Search again");
    expect(none).toContain("No lyrics found for this song.");
    expect(render("failed")).toContain("Couldn&#x27;t fetch lyrics.");
    expect(render("failed")).toContain('data-testid="lyrics-fetch"');

    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const onFetch = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ParrotLyricsPane lyrics={null} positionMs={0} labels={labels} fetchLyrics={{ state: "none", onFetch, labels: fetchLabels }} />));
    await act(async () => host.querySelector<HTMLElement>('[data-testid="lyrics-fetch"]')!.click());
    expect(onFetch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    host.remove();
  });
});

// @req PAR-LYR-01[parrot]
// @req PAR-LYR-04[parrot]
describe("[parrot] no lyrics anywhere", () => {
  const found = { ...labels, noLyricsFoundTitle: "No lyrics", noLyricsFoundBody: "No lyrics found for this song." };
  const notFound = { synced: null, plain: null, fetched: true, notFound: true as const };

  it("says 'No lyrics' and that none was found once every source had none, keeping Search again to look again", () => {
    const html = renderToStaticMarkup(
      <ParrotLyricsPane lyrics={notFound} positionMs={0} labels={found} fetchLyrics={{ state: "idle", onFetch: () => {}, labels: fetchLabels }} />
    );
    console.info("[parrot-lyrics] not found", html);
    expect(html).toContain(">No lyrics<");
    expect(html).not.toContain("No lyrics yet");
    expect(html).toContain("No lyrics found for this song.");
    expect(html).toContain('data-found="none"');
    expect(html).toContain('data-testid="lyrics-fetch"');
  });

  it("a manual search that finds nothing shows the same final state, with Search again", () => {
    const html = renderToStaticMarkup(<ParrotLyricsPane lyrics={null} positionMs={0} labels={found} fetchLyrics={{ state: "none", onFetch: () => {}, labels: fetchLabels }} />);
    expect(html).toContain(">No lyrics<");
    expect(html).toContain('data-testid="lyrics-fetch"');
  });

  it("a song not looked up yet still says 'No lyrics yet'; an app without the final labels keeps it too", () => {
    const pending = renderToStaticMarkup(<ParrotLyricsPane lyrics={null} positionMs={0} labels={found} fetchLyrics={{ state: "idle", onFetch: () => {}, labels: fetchLabels }} />);
    expect(pending).toContain("No lyrics yet");
    expect(pending).not.toContain("data-found");
    const plainApp = renderToStaticMarkup(<ParrotLyricsPane lyrics={notFound} positionMs={0} labels={labels} />);
    expect(plainApp).toContain("No lyrics yet");
    const withLabels = renderToStaticMarkup(<ParrotLyricsPane lyrics={notFound} positionMs={0} labels={found} />);
    expect(withLabels).toContain(">No lyrics<");
    expect(withLabels).toContain("No lyrics found for this song.");
  });
});

// @req PAR-LYR-06[parrot]
// @req PAR-LYR-06[parrot-web-player]
describe("[parrot] searching while a lookup runs", () => {
  const found = { ...labels, noLyricsFoundTitle: "No lyrics", noLyricsFoundBody: "No lyrics found for this song." };
  const notFound = { synced: null, plain: null, fetched: true, notFound: true as const };
  const searching = { synced: null, plain: null, fetched: false, searching: true as const };
  const pane = (lyrics: Parameters<typeof ParrotLyricsPane>[0]["lyrics"], state: "idle" | "busy" | "none" | "failed") =>
    renderToStaticMarkup(<ParrotLyricsPane lyrics={lyrics} positionMs={0} labels={found} fetchLyrics={{ state, onFetch: () => {}, labels: fetchLabels }} />);
  const expectSearching = (html: string) => {
    expect(html).toContain('data-testid="lyrics-searching"');
    expect(html).toContain("Looking for lyrics…");
    expect(html).not.toContain("No lyrics yet");
    expect(html).not.toContain(">No lyrics<");
    expect(html).not.toContain('data-testid="lyrics-fetch"');
  };

  it("a song kept as 'No lyrics' that the user asks again shows 'Looking for lyrics…' until the answer, not 'No lyrics'", () => {
    const html = pane(notFound, "busy");
    console.info("[parrot-lyrics] busy after not found", html);
    expectSearching(html);
  });

  it("a song the automatic lookup has queued or running shows 'Looking for lyrics…', not 'No lyrics yet'", () => {
    const html = pane(searching, "idle");
    console.info("[parrot-lyrics] automatic lookup pending", html);
    expectSearching(html);
    const withoutFetch = renderToStaticMarkup(<ParrotLyricsPane lyrics={searching} positionMs={0} labels={found} />);
    console.info("[parrot-lyrics] automatic lookup pending, app without Fetch", withoutFetch);
    expect(withoutFetch).toContain('data-testid="lyrics-searching"');
    expect(withoutFetch).not.toContain("No lyrics yet");
  });

  it("says nothing about lyrics while the app is still reading them", () => {
    const html = pane(undefined, "idle");
    console.info("[parrot-lyrics] still reading", html);
    expect(html).toContain('data-testid="lyrics-reading"');
    expect(html).not.toContain("No lyrics");
  });

  it("once the lookup finished with none, the final 'No lyrics' shows", () => {
    const afterAuto = pane(notFound, "idle");
    console.info("[parrot-lyrics] automatic lookup finished with none", afterAuto);
    expect(afterAuto).toContain(">No lyrics<");
    expect(afterAuto).not.toContain('data-testid="lyrics-searching"');
    const afterFetch = pane(null, "none");
    console.info("[parrot-lyrics] Fetch lyrics finished with none", afterFetch);
    expect(afterFetch).toContain(">No lyrics<");
    expect(afterFetch).not.toContain('data-testid="lyrics-searching"');
  });
});
