/**
 * @test-id SHARED-ARTWORK-STATE-001
 * @level unit
 * @req UX-WAIT-03
 * @why Chris 2026-11-16: "some posters show up without images (I suppose while the image loads) ... there should be a
 *   small spinning thing showing that it's loading. A simple black poster looks like something is broken". Every tile
 *   on every client runs these transitions: loading (spinner), loaded (picture), failed (icon and title), never stuck.
 */
import { describe, expect, it } from "vitest";
import {
  ARTWORK_LOAD_TIMEOUT_MS,
  ARTWORK_SPINNER_DELAY_MS,
  artworkAwaitsSource,
  artworkReducer,
  artworkStateFor,
  type ArtworkEvent,
  type ArtworkState,
} from "../src/artworkImage";

const run = (start: ArtworkState, events: ArtworkEvent[]) => events.reduce(artworkReducer, start);
const pending = { type: "source", source: { kind: "pending" } } as const;
const none = { type: "source", source: { kind: "none" } } as const;
const url = (value: string) => ({ type: "source", source: { kind: "url", url: value } }) as const;

describe("artwork tile states (UX-WAIT-03)", () => {
  it("starts in the look its source gives: loading while fetched or drawn, failed when there is none", () => {
    expect(artworkStateFor({ kind: "pending" })).toEqual({ phase: "loading", url: null });
    expect(artworkStateFor({ kind: "url", url: "file:///p.jpg" })).toEqual({ phase: "loading", url: "file:///p.jpg" });
    expect(artworkStateFor({ kind: "none" })).toEqual({ phase: "failed", url: null });
  });

  it("loading → loaded: the fetch answers, then the image view draws the picture", () => {
    const states = [artworkStateFor({ kind: "pending" })];
    states.push(artworkReducer(states.at(-1)!, url("blob:a")));
    states.push(artworkReducer(states.at(-1)!, { type: "load", url: "blob:a" }));
    console.info("[SHARED-ARTWORK-STATE-001] loaded path", JSON.stringify(states));
    expect(states.map((s) => s.phase)).toEqual(["loading", "loading", "loaded"]);
    expect(states.at(-1)!.url).toBe("blob:a");
  });

  it("loading → failed: no picture, or the image view cannot draw it", () => {
    expect(run(artworkStateFor({ kind: "pending" }), [none])).toEqual({ phase: "failed", url: null });
    expect(run(artworkStateFor({ kind: "pending" }), [url("blob:a"), { type: "error", url: "blob:a" }])).toEqual({ phase: "failed", url: null });
  });

  it("a fetch that never answers times out to the fallback; a picture with an address is never timed out", () => {
    const waiting = artworkStateFor({ kind: "pending" });
    expect(artworkAwaitsSource(waiting)).toBe(true);
    expect(artworkReducer(waiting, { type: "timeout" })).toEqual({ phase: "failed", url: null });
    // A lazy web <img> may hold its decode until it is scrolled to: the clock does not run for it.
    const drawing = artworkStateFor({ kind: "url", url: "blob:a" });
    expect(artworkAwaitsSource(drawing)).toBe(false);
    expect(artworkReducer(drawing, { type: "timeout" })).toBe(drawing);
    expect(ARTWORK_LOAD_TIMEOUT_MS).toBe(15_000);
    expect(ARTWORK_SPINNER_DELAY_MS).toBeLessThan(ARTWORK_LOAD_TIMEOUT_MS);
  });

  it("a picture that arrives after the tile gave up fades in over the fallback, with no spinner again", () => {
    const states = [run(artworkStateFor({ kind: "pending" }), [{ type: "timeout" }])];
    states.push(artworkReducer(states.at(-1)!, url("blob:late")));
    states.push(artworkReducer(states.at(-1)!, { type: "load", url: "blob:late" }));
    console.info("[SHARED-ARTWORK-STATE-001] late picture", JSON.stringify(states));
    expect(states.map((s) => s.phase)).toEqual(["failed", "failed", "loaded"]);
    // Still waiting again (a new session's fetch) keeps the fallback rather than spinning anew.
    expect(run(states[1]!, [pending])).toEqual({ phase: "failed", url: null });
  });

  it("ignores load and error events of a picture the tile no longer shows, and repeats of the same answer", () => {
    const showingB = run(artworkStateFor({ kind: "pending" }), [url("blob:a"), url("blob:b")]);
    expect(showingB).toEqual({ phase: "loading", url: "blob:b" });
    expect(artworkReducer(showingB, { type: "load", url: "blob:a" })).toBe(showingB);
    expect(artworkReducer(showingB, { type: "error", url: "blob:a" })).toBe(showingB);
    expect(artworkReducer(showingB, url("blob:b"))).toBe(showingB);
    const loaded = artworkReducer(showingB, { type: "load", url: "blob:b" });
    expect(artworkReducer(loaded, { type: "load", url: "blob:b" })).toBe(loaded);
    const failed = run(artworkStateFor({ kind: "none" }), [none]);
    expect(failed).toEqual({ phase: "failed", url: null });
  });
});
