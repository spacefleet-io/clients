/**
 * STOR-BW-11 / UX-PROF-01: when the server refuses the profile named on a playback (a profile deleted on another
 * device: 403 `profile_not_owned`), or no profile is picked (`profile_required`), the playback server tells its owner,
 * which pushes it to the renderer's profile store (`sf-playback-profile-refused`) so the list is re-read at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageTunnelError } from "@space/shared/storageTunnel";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/forceGc", () => ({ runFullGc: () => ({ ms: 1 }) }));
vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";
import { PlaybackServer } from "../src/main/playbackServer";

const LOG = "[profiles-playback-refused]";
const KID_PROFILE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const fetchSegment = async (server: PlaybackServer) => {
  // fetchObjectViaTunnel is private; this suite drives the single segment fetch every playback path goes through.
  const fetcher: unknown = server;
  if (!fetcher || typeof fetcher !== "object" || !("fetchObjectViaTunnel" in fetcher) || typeof fetcher.fetchObjectViaTunnel !== "function") {
    throw new Error("PlaybackServer.fetchObjectViaTunnel missing");
  }
  return await fetcher.fetchObjectViaTunnel.call(server, "seg-0");
};

describe("desktop playback reports a refused profile @req STOR-BW-11[badger-desktop]", () => {
  beforeEach(() => {
    downloadToSinkMock.mockReset();
    vi.stubEnv("SF_PLAYBACK_OBJECT_FETCH_RETRY_DELAY_MS", "0");
  });

  afterEach(() => {
    setActivePlaybackProfileId(null);
    vi.unstubAllEnvs();
  });

  // @req UX-PROF-01[badger-desktop]
  it("@bugfix reports profile_not_owned and profile_required to its owner, once per refused request", async () => {
    const refusals: string[] = [];
    const server = new PlaybackServer({ onPlaybackProfileRefused: (code) => refusals.push(code) });
    server.setToken("test-token");
    try {
      setActivePlaybackProfileId(KID_PROFILE);
      downloadToSinkMock.mockRejectedValue(new StorageTunnelError(403, { error: "profile_not_owned" }));
      await expect(fetchSegment(server)).rejects.toMatchObject({ code: "profile_not_owned" });
      setActivePlaybackProfileId(null);
      await expect(fetchSegment(server)).rejects.toMatchObject({ code: "profile_required" });
      downloadToSinkMock.mockRejectedValue(new StorageTunnelError(503, { error: "storage_unavailable" }));
      setActivePlaybackProfileId(KID_PROFILE);
      await fetchSegment(server).catch(() => undefined);
      console.info(`${LOG} refusals=${JSON.stringify(refusals)} downloads=${downloadToSinkMock.mock.calls.length}`);
      expect(refusals).toEqual(["profile_not_owned", "profile_required"]);
    } catch (error) {
      console.error(`${LOG} failed`, JSON.stringify({ refusals, downloads: downloadToSinkMock.mock.calls.length }));
      throw error;
    }
  });
});
