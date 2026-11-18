/**
 * @req STOR-BW-11
 *
 * Every desktop playback request names the profile picked at "Who's watching?", the main profile's real id on a single-profile
 * account too. With no profile picked the playback server makes no request at all and fails `profile_required` once, never
 * retried and never guessed; a profile the server says is not the account's (403 `profile_not_owned`) is final too.
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

const SUITE = "playback-server-profile";
const MAIN_PROFILE = "4d3c2b1a-0f9e-4d8c-b7a6-5f4e3d2c1b0a";
const KID_PROFILE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

type Fetcher = { fetchObjectViaTunnel: (key: string) => Promise<Buffer> };
const fetchSegment = (server: PlaybackServer) => (server as unknown as Fetcher).fetchObjectViaTunnel("seg-0");

const sentProfiles = () => {
  const profiles = downloadToSinkMock.mock.calls.map((call) => (call[3] as { profileId?: unknown } | undefined)?.profileId ?? null);
  console.info(`[${SUITE}:sent] calls=${downloadToSinkMock.mock.calls.length} profiles=${JSON.stringify(profiles)}`);
  return profiles;
};

describe("desktop playback names its profile @req STOR-BW-11[badger-desktop]", () => {
  beforeEach(() => {
    downloadToSinkMock.mockReset();
    vi.stubEnv("SF_PLAYBACK_OBJECT_FETCH_RETRY_DELAY_MS", "0");
  });

  afterEach(() => {
    setActivePlaybackProfileId(null);
    vi.unstubAllEnvs();
  });

  it("sends the main profile's real id on a single-profile account", async () => {
    setActivePlaybackProfileId(MAIN_PROFILE);
    const server = new PlaybackServer({});
    server.setToken("test-token");
    downloadToSinkMock.mockResolvedValue({ bytes: 0 });
    await fetchSegment(server);
    expect(sentProfiles()).toEqual([MAIN_PROFILE]);
    expect(downloadToSinkMock.mock.calls[0]?.[3]).toMatchObject({ purpose: "playback", profileId: MAIN_PROFILE });
  });

  it("follows the profile picked at Who's watching?", async () => {
    const server = new PlaybackServer({});
    server.setToken("test-token");
    downloadToSinkMock.mockResolvedValue({ bytes: 0 });
    setActivePlaybackProfileId(MAIN_PROFILE);
    await fetchSegment(server);
    setActivePlaybackProfileId(KID_PROFILE);
    await fetchSegment(server);
    expect(sentProfiles()).toEqual([MAIN_PROFILE, KID_PROFILE]);
  });

  it("makes no request and fails profile_required once when no profile is picked", async () => {
    setActivePlaybackProfileId(null);
    const server = new PlaybackServer({});
    server.setToken("test-token");
    const error = await fetchSegment(server).catch((caught: unknown) => caught);
    console.info(`[${SUITE}:missing] error=${String(error)}`);
    expect(error).toBeInstanceOf(StorageTunnelError);
    expect((error as StorageTunnelError).code).toBe("profile_required");
    expect(downloadToSinkMock).not.toHaveBeenCalled();
  });

  it("does not retry a profile the server says is not the account's", async () => {
    setActivePlaybackProfileId(KID_PROFILE);
    const server = new PlaybackServer({});
    server.setToken("test-token");
    downloadToSinkMock.mockRejectedValue(new StorageTunnelError(403, { error: "profile_not_owned" }));
    await expect(fetchSegment(server)).rejects.toMatchObject({ code: "profile_not_owned" });
    expect(downloadToSinkMock).toHaveBeenCalledTimes(1);
  });
});
