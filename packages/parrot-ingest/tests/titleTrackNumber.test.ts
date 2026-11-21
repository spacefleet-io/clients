/**
 * @test-id PARROT-INGEST-TITLENUMBER-001
 * @level unit
 * @why PAR-META-21: real mp3s prove a song read for import loses its title tag's leading track number, takes it as the
 *      track number when the track-number tag is missing, keeps a disagreeing tag's, and leaves a title that is a number.
 * @covers packages/parrot-ingest/src/readTrack.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readParrotTrackInfo } from "../src/readTrack";
import { makeAudioFixture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-TITLENUMBER-001");

describe("readParrotTrackInfo with a numbered title tag", () => {
  let root = "";
  beforeAll(async () => {
    root = await makeTempDir("titlenumber");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("takes the number out of the title and uses it when the track-number tag is missing", async () => {
    const info = await readParrotTrackInfo(makeAudioFixture(path.join(root, "untracked.mp3"), { title: "02. Wildfire", artist: "Linnet Park", album: "Meltway" }, 1, log));
    expect({ title: info.title, number: info.number }).toEqual({ title: "Wildfire", number: 2 });
  });

  it("keeps the track-number tag when the title's number disagrees", async () => {
    const info = await readParrotTrackInfo(makeAudioFixture(path.join(root, "tracked.mp3"), { title: "02. Wildfire", artist: "Linnet Park", album: "Meltway", track: "5/9" }, 1, log));
    expect({ title: info.title, number: info.number }).toEqual({ title: "Wildfire", number: 5 });
  });

  it("leaves a title that is a number alone", async () => {
    const info = await readParrotTrackInfo(makeAudioFixture(path.join(root, "07 - Prince.mp3"), { title: "1999", artist: "Prince", album: "1999" }, 1, log));
    expect({ title: info.title, number: info.number }).toEqual({ title: "1999", number: 7 });
  });
});
