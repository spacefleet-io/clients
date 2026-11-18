/**
 * @test-id MPV-SUBWARM-001
 * @level unit
 * @bugfix @regression-proof
 * @why mpv holds the picture while it waits for an external subtitle file (it is not interleaved with the video).
 *   The loopback proxy only answers once it has fetched and decrypted the WHOLE sidecar (a PGS track runs to
 *   31 MB, 10-16 s on a TV), so calling `sub-add` straight away froze the picture for seconds and the catch-up
 *   dropped ~160 frames, raising the false "not powerful enough" notice. The sidecar must be fetched into the
 *   proxy first (a one-byte range request), and only then handed to mpv.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ NativeModules: {} }));

import { warmSidecar, withSidecarWarmup } from "../src/sidecarWarmup";

const URL = "http://127.0.0.1:44601/playback/object/media%2Fabc%2F58211b81";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every already-settled promise continue, without waiting on the clock. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("withSidecarWarmup", () => {
  it("hands the subtitle to mpv only after the proxy has the sidecar", async () => {
    const order: string[] = [];
    const warm = deferred();
    const native = {
      addSubtitle: vi.fn(async (url: string, _language: string | null, _title: string | null) => {
        order.push(`add ${url}`);
        return true;
      }),
      removeAllSubtitles: vi.fn(async () => true),
    };
    const player = withSidecarWarmup(native, (url) => {
      order.push(`warm ${url}`);
      return warm.promise;
    });

    const added = player.addSubtitle(URL, "fr", "fre");
    await flush();
    console.info("[subwarm:before-warm-done]", JSON.stringify(order));
    expect(native.addSubtitle).not.toHaveBeenCalled();

    warm.resolve();
    await expect(added).resolves.toBe(true);
    console.info("[subwarm:after-warm-done]", JSON.stringify(order));
    expect(order).toEqual([`warm ${URL}`, `add ${URL}`]);
    expect(native.addSubtitle).toHaveBeenCalledWith(URL, "fr", "fre");
  });

  it("still asks mpv to load the subtitle when the warm-up fails, so a dead sidecar surfaces as a load failure", async () => {
    const native = {
      addSubtitle: vi.fn(async (_url: string, _language: string | null, _title: string | null): Promise<boolean> => {
        throw Object.assign(new Error("sub-add did not add a track"), { code: "subtitle_load_failed" });
      }),
    };
    const player = withSidecarWarmup(native, async () => {
      throw new Error("proxy 502");
    });

    await expect(player.addSubtitle(URL, null, null)).rejects.toMatchObject({ code: "subtitle_load_failed" });
    expect(native.addSubtitle).toHaveBeenCalledTimes(1);
  });

  it("leaves every other native method untouched", async () => {
    const native = { addSubtitle: vi.fn(async () => true), removeAllSubtitles: vi.fn(async () => true) };
    const player = withSidecarWarmup(native, async () => undefined);
    await player.removeAllSubtitles();
    expect(native.removeAllSubtitles).toHaveBeenCalledTimes(1);
  });
});

describe("warmSidecar", () => {
  it("asks the proxy for one byte, which makes it fetch the whole sidecar without moving it over the bridge", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 206 }));
    await warmSidecar(URL, fetchImpl);
    console.info("[subwarm:fetch-call]", JSON.stringify(fetchImpl.mock.calls));
    expect(fetchImpl).toHaveBeenCalledWith(URL, { headers: { Range: "bytes=0-0" } });
  });

  it("rejects when the proxy answers with an error status", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 502 }));
    await expect(warmSidecar(URL, fetchImpl)).rejects.toThrow(/502/);
  });
});
