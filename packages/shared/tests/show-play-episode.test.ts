// @req LIB-DETAIL-01
import { describe, expect, it } from "vitest";
import { pickShowPlayEpisode } from "../src/showPlayEpisode";

type Ep = { id: string; file: boolean; watched: boolean };
const eps: Ep[] = [
  { id: "s1e1", file: true, watched: true },
  { id: "s1e2", file: false, watched: false },
  { id: "s1e3", file: true, watched: false },
  { id: "s1e4", file: true, watched: false },
];
const hasFile = (episode: Ep) => episode.file;
const isWatched = (episode: Ep) => episode.watched;

describe("a show's main Play episode (LIB-DETAIL-01)", () => {
  it("continues the episode last played, even one without a file here", () => {
    const picked = pickShowPlayEpisode(eps, { resumeEpisodeId: "s1e4", hasFile, isWatched });
    console.log("[show-play] resume s1e4 ->", picked?.id);
    expect(picked?.id).toBe("s1e4");
    expect(pickShowPlayEpisode(eps, { resumeEpisodeId: "s1e2", hasFile })?.id).toBe("s1e2");
  });

  it("else the first unwatched episode with a file, when watched state is known", () => {
    const picked = pickShowPlayEpisode(eps, { resumeEpisodeId: null, hasFile, isWatched });
    console.log("[show-play] no resume, watched known ->", picked?.id);
    expect(picked?.id).toBe("s1e3");
  });

  it("else the first episode with a file; an unknown resume id falls through", () => {
    expect(pickShowPlayEpisode(eps, { resumeEpisodeId: null, hasFile })?.id).toBe("s1e1");
    expect(pickShowPlayEpisode(eps, { resumeEpisodeId: "gone", hasFile })?.id).toBe("s1e1");
    const allWatched = eps.map((episode) => ({ ...episode, watched: true }));
    expect(pickShowPlayEpisode(allWatched, { resumeEpisodeId: null, hasFile, isWatched })?.id).toBe("s1e1");
  });

  it("nothing when no episode has a file", () => {
    expect(pickShowPlayEpisode(eps, { resumeEpisodeId: null, hasFile: () => false, isWatched })).toBeNull();
  });
});
