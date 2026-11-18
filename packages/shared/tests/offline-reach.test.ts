import { describe, expect, it } from "vitest";
import { anyOnDevice, episodeKey, episodeKeysOnDevice, playableEpisodeKeysNow, unavailableOffline } from "../src/offlineReach";

/**
 * @test-id SHARED-OFFLINE-REACH-001
 * @level unit
 * @req OFFL-PLAY-03
 * @req PAR-OFFL-04
 * @why Offline, Badger's phone and computer grey out and refuse to start every title and episode that is not downloaded,
 *   and Parrot does the same for songs (one rule, `@space/shared/offlineReach`). A wrong answer either lets a tap start
 *   a stream that cannot load, or greys out a downloaded film the user can watch on the plane.
 */
describe("offline reach", () => {
  it("greys out only what is off the device, and only while offline", () => {
    const cases = [
      { online: true, onDevice: false, greyed: false },
      { online: true, onDevice: true, greyed: false },
      { online: false, onDevice: true, greyed: false },
      { online: false, onDevice: false, greyed: true },
    ];
    for (const c of cases) {
      const greyed = unavailableOffline(c.online, c.onDevice);
      console.info("offline-reach.case", JSON.stringify({ ...c, got: greyed }));
      expect(greyed).toBe(c.greyed);
    }
  });

  it("keeps a collection (show, playlist) in colour when one member is on the device", () => {
    const onDevice = new Set(["e2"]);
    expect(anyOnDevice(onDevice, ["e1", "e2", "e3"])).toBe(true);
    expect(anyOnDevice(onDevice, ["e1", "e3"])).toBe(false);
    expect(anyOnDevice(onDevice, [])).toBe(false);
  });

  it("maps downloaded files to episode keys and skips a film's files", () => {
    const files = [
      { id: "movie", season: null, episode: null },
      { id: "s1e1-1080", season: 1, episode: 1 },
      { id: "s1e1-720", season: 1, episode: 1 },
      { id: "s1e2", season: 1, episode: 2 },
      { id: "s2e1", season: 2, episode: 1 },
    ];
    const downloaded = new Set(["movie", "s1e1-720", "s2e1"]);
    const keys = episodeKeysOnDevice(files, (id) => downloaded.has(id));
    console.info("offline-reach.episodes", JSON.stringify([...keys]));
    expect([...keys].sort()).toEqual([episodeKey(1, 1), episodeKey(2, 1)]);
  });

  it("lets every episode with a file start online, and only downloaded ones offline", () => {
    const withFile = new Set(["1-1", "1-2", "2-1"]);
    const onDevice = new Set(["1-2", "3-1"]);
    expect(playableEpisodeKeysNow(true, withFile, onDevice)).toBe(withFile);
    expect([...playableEpisodeKeysNow(false, withFile, onDevice)]).toEqual(["1-2"]);
    expect(playableEpisodeKeysNow(false, withFile, new Set()).size).toBe(0);
  });
});
