import { describe, expect, it, vi } from "vitest";
import { resolveSelectedMediaDetails } from "../src/renderer/src/lib/mediaDetailsSelection";
import { buildMediaDetailsFixture } from "./_helpers/mediaDetailsFixture";

const movieDetails = () =>
  buildMediaDetailsFixture({
    id: "media-1",
    type: "movie",
    title: "Forrest Gump",
    files: [],
    formats: [],
    episodes: [],
    audioTracks: [],
    subtitleTracks: [],
  });

describe("resolveSelectedMediaDetails", () => {
  it("[@bugfix][@regression-proof] fetches media details when a route-selected media is missing from the in-memory details map", async () => {
    const details = movieDetails();
    const getMediaDetails = vi.fn(() => null);
    const fetchMediaDetails = vi.fn(async () => details);

    await expect(resolveSelectedMediaDetails("media-1", getMediaDetails, fetchMediaDetails)).resolves.toEqual(details);
    expect(getMediaDetails).toHaveBeenCalledWith("media-1");
    expect(fetchMediaDetails).toHaveBeenCalledWith("media-1");
  });

  it("reuses cached media details when the in-memory details map is warm", async () => {
    const details = movieDetails();
    const getMediaDetails = vi.fn(() => details);
    const fetchMediaDetails = vi.fn(async () => null);

    await expect(resolveSelectedMediaDetails("media-1", getMediaDetails, fetchMediaDetails)).resolves.toEqual(details);
    expect(fetchMediaDetails).not.toHaveBeenCalled();
  });
});
