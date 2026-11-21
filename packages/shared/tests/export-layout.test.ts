import { describe, expect, it } from "vitest";
import { buildExportPath, sanitizeExportFolderName } from "../src/exportLayout";

// OFFL-FILE-01/02, ACCT-EXPORT-01: where an exported Badger title lands inside the folder the user picked.
describe("buildExportPath", () => {
  it("Movies/<Title (Year)>.<ext> and Shows/<Show>/Season NN/<episode file>", () => {
    const movie = buildExportPath({ kind: "movie", title: "Lattice", year: 1999, container: "mkv" });
    const episode = buildExportPath(
      { kind: "episode", showTitle: "Dust Park", seasonNumber: 2, episodeNumber: 3, episodeTitle: null, container: "mkv" },
    );
    const special = buildExportPath(
      { kind: "episode", showTitle: "Dust Park", seasonNumber: 0, episodeNumber: 1, container: "mkv" },
    );
    console.info(`[export-layout:library] movie=${JSON.stringify(movie)} episode=${JSON.stringify(episode)} special=${JSON.stringify(special)}`);
    expect(movie).toEqual({ dirs: ["Movies"], filename: "Lattice (1999).mkv" });
    expect(episode).toEqual({ dirs: ["Shows", "Dust Park", "Season 02"], filename: "Dust Park - S02E03.mkv" });
    expect(special).toEqual({ dirs: ["Shows", "Dust Park", "Season 00"], filename: "Dust Park - S00E01.mkv" });
  });

  it("unsafe characters are removed from the show folder and the file name (OFFL-FILE-02)", () => {
    const got = buildExportPath(
      { kind: "episode", showTitle: 'What/If: "Part" <1>?', seasonNumber: 1, episodeNumber: 1, episodeTitle: "A|B", container: "mkv" },
    );
    console.info(`[export-layout:unsafe] got=${JSON.stringify(got)}`);
    expect(got).toEqual({ dirs: ["Shows", "WhatIf Part 1", "Season 01"], filename: "WhatIf Part 1 - S01E01 - AB.mkv" });
  });
});

describe("sanitizeExportFolderName", () => {
  it("keeps a trailing word after a dot (never read as an extension) and guards reserved and empty names", () => {
    const cases = [
      ["Dr.Who", "Dr.Who"],
      ["Mr. Robot", "Mr. Robot"],
      ["CON", "CON_"],
      ["...", "untitled"],
      ["  Lost.  ", "Lost"],
    ] as const;
    const got = cases.map(([raw]) => sanitizeExportFolderName(raw));
    console.info(`[export-layout:folder] ${JSON.stringify(cases.map(([raw], i) => [raw, got[i]]))}`);
    expect(got).toEqual(cases.map(([, want]) => want));
  });
});
