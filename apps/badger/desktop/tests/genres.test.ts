import { describe, expect, it } from "vitest";
import { genreIcon } from "@space/ui/badger/genre-icons";
import { getGenreName, getGenreOptions } from "../src/renderer/src/lib/genres";

describe("genre helpers", () => {
  it("returns genre options for both categories by default", () => {
    const options = getGenreOptions();
    const categories = new Set(options.map((entry) => entry.category));
    expect(categories.has("movie")).toBe(true);
    expect(categories.has("tv")).toBe(true);
  });

  it("names a genre in the app language from the shared names, English for an unknown language", () => {
    expect(getGenreName("movie", 878, "fr")).toBe("Science-fiction");
    expect(getGenreName("movie", 878, "fr")).not.toBe(getGenreName("movie", 878, "en"));
    expect(getGenreName("movie", 28, "xx")).toBe("Action");
    expect(getGenreName("movie", 999999, "en")).toBeNull();
  });

  it("returns fallback icon for unknown genre id", () => {
    const known = genreIcon("movie", 28);
    const unknown = genreIcon("movie", 999999);
    expect(known).toBeTruthy();
    expect(unknown).toBeTruthy();
    expect(unknown).not.toBe(known);
  });
});
