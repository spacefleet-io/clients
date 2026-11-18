/**
 * @test-id MPV-SUBLATE-001
 * @level unit
 * @bugfix @regression-proof
 * @why Desktop launch waited up to 3 s for every subtitle sidecar to download, then handed mpv the raw proxy URLs
 *   of those still downloading. mpv reads an external subtitle up to the playing moment before showing the next
 *   frame, so a remembered 30 MB PGS track resumed late in the film froze the picture (~2 s, 50 dropped frames in a
 *   probe of the bundled mpv; a cached file adds in 3 ms with no drop). Launch must not wait on a sidecar, and mpv
 *   must only ever get a sidecar from disk.
 */
import { describe, expect, it, vi } from "vitest";
import { fillLateSidecars, splitLaunchSidecars, type SubtitleSidecar } from "../src/lateSubtitleSidecars";

const proxy = (key: string, port = 41000) => `http://127.0.0.1:${port}/playback/object/media%2F${key}`;

const deferred = <T>() => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const makeLog = () => {
  const lines: string[] = [];
  const log = {
    info: (fields: Record<string, unknown>, message: string) => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
      console.log("[test] info", message, fields);
    },
    warn: (fields: Record<string, unknown>, message: string) => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
      console.log("[test] warn", message, fields);
    },
  };
  return { log, lines };
};

const eng: SubtitleSidecar = { url: proxy("eng"), title: "English", lang: "eng", format: "subrip" };
const cze: SubtitleSidecar = { url: proxy("cze"), title: "Czech", lang: "cze", format: "hdmv_pgs_subtitle", selected: true };

describe("splitLaunchSidecars", () => {
  it("puts only sidecars already on disk in the launch payload, and never fetches", async () => {
    const cache = vi.fn(async (entries: SubtitleSidecar[], options: { cachedOnly: boolean }) => {
      console.log("[test] cache", options, entries.map((e) => e.url));
      return entries.map((entry) => ({ url: entry.lang === "eng" ? "/cache/eng.srt" : "" }));
    });
    const split = await splitLaunchSidecars([eng, cze], cache);
    console.log("[test] split", split);
    expect(cache).toHaveBeenCalledTimes(1);
    expect(cache.mock.calls[0][1]).toEqual({ cachedOnly: true });
    expect(split.ready).toEqual([{ ...eng, url: "/cache/eng.srt" }]);
    expect(split.pending).toEqual([cze]);
  });

  it("skips the cache call when there is no sidecar", async () => {
    const cache = vi.fn();
    expect(await splitLaunchSidecars([], cache)).toEqual({ ready: [], pending: [] });
    expect(cache).not.toHaveBeenCalled();
  });
});

describe("fillLateSidecars", () => {
  it("hands each sidecar to mpv as a disk path once it lands, keeping the remembered selection", async () => {
    const czeFetch = deferred<Array<{ url: string }>>();
    const cache = vi.fn((entries: SubtitleSidecar[]) => czeFetch.promise.then((r) => (entries[0] === cze ? r : [])));
    const send = vi.fn(async (list: SubtitleSidecar[]) => console.log("[test] send", list));
    const { log, lines } = makeLog();
    const ready = [{ ...eng, url: "/cache/eng.srt" }];
    const fill = fillLateSidecars({ ready, pending: [cze], cache, stillSelected: () => true, isCurrent: () => true, send, log });
    await flush();
    expect(cache.mock.calls[0]).toEqual([[cze], { cachedOnly: false }]);
    expect(send).not.toHaveBeenCalled();
    czeFetch.resolve([{ url: "/cache/cze.sup" }]);
    await fill.settled;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([...ready, { ...cze, url: "/cache/cze.sup", selected: true }]);
    expect(send.mock.calls[0][0].every((s: SubtitleSidecar) => !s.url.startsWith("http"))).toBe(true);
    expect(lines.some((l) => l.startsWith("sidecar.late_added"))).toBe(true);
  });

  it("never gives mpv the raw URL of a sidecar whose fetch failed, and logs it", async () => {
    const cache = vi.fn(async () => [{ url: "" }]);
    const send = vi.fn(async () => undefined);
    const { log, lines } = makeLog();
    const fill = fillLateSidecars({ ready: [], pending: [cze], cache, stillSelected: () => true, isCurrent: () => true, send, log });
    await fill.settled;
    expect(send).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("sidecar.late_failed"))).toBe(true);
  });

  it("logs a thrown fetch as a failure without rejecting", async () => {
    const cache = vi.fn(async () => {
      throw new Error("ipc gone");
    });
    const send = vi.fn(async () => undefined);
    const { log, lines } = makeLog();
    const fill = fillLateSidecars({ ready: [], pending: [cze], cache, stillSelected: () => true, isCurrent: () => true, send, log });
    await expect(fill.settled).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("ipc gone"))).toBe(true);
  });

  it("does not select a landed sidecar the user moved away from during the download", async () => {
    const cache = vi.fn(async () => [{ url: "/cache/cze.sup" }]);
    const send = vi.fn(async (_sidecars: SubtitleSidecar[]) => undefined);
    const fill = fillLateSidecars({ ready: [], pending: [cze], cache, stillSelected: () => false, isCurrent: () => true, send, log: makeLog().log });
    await fill.settled;
    expect(send.mock.calls[0][0]).toEqual([{ ...cze, url: "/cache/cze.sup", selected: false }]);
  });

  it("drops a sidecar that lands after the fill was cancelled or playback moved on", async () => {
    const fetch = deferred<Array<{ url: string }>>();
    const send = vi.fn(async () => undefined);
    const cancelledFill = fillLateSidecars({ ready: [], pending: [cze], cache: () => fetch.promise, stillSelected: () => true, isCurrent: () => true, send, log: makeLog().log });
    const staleFill = fillLateSidecars({ ready: [], pending: [eng], cache: () => fetch.promise, stillSelected: () => true, isCurrent: () => false, send, log: makeLog().log });
    cancelledFill.cancel();
    fetch.resolve([{ url: "/cache/x" }]);
    await Promise.all([cancelledFill.settled, staleFill.settled]);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the growing list as each sidecar lands, in landing order", async () => {
    const engFetch = deferred<Array<{ url: string }>>();
    const czeFetch = deferred<Array<{ url: string }>>();
    const cache = (entries: SubtitleSidecar[]) => (entries[0] === eng ? engFetch.promise : czeFetch.promise);
    const send = vi.fn(async (_sidecars: SubtitleSidecar[]) => undefined);
    const fill = fillLateSidecars({ ready: [], pending: [eng, cze], cache, stillSelected: () => true, isCurrent: () => true, send, log: makeLog().log });
    czeFetch.resolve([{ url: "/cache/cze.sup" }]);
    await flush();
    engFetch.resolve([{ url: "/cache/eng.srt" }]);
    await fill.settled;
    expect(send.mock.calls.map((c) => c[0].map((s) => s.url))).toEqual([
      ["/cache/cze.sup"],
      ["/cache/cze.sup", "/cache/eng.srt"],
    ]);
  });

  it("owns its pending sidecars by object key, whatever the proxy port", () => {
    const fill = fillLateSidecars({ ready: [], pending: [cze], cache: () => new Promise(() => {}), stillSelected: () => true, isCurrent: () => true, send: async () => undefined, log: makeLog().log });
    expect(fill.owns(proxy("cze", 52000))).toBe(true);
    expect(fill.owns(proxy("eng"))).toBe(false);
  });

  it("selects a landed sidecar the user picked during the download, even when it was not the remembered one", async () => {
    const cache = vi.fn(async () => [{ url: "/cache/eng.srt" }]);
    const send = vi.fn(async (_sidecars: SubtitleSidecar[]) => undefined);
    const fill = fillLateSidecars({ ready: [], pending: [eng], cache, stillSelected: () => true, isCurrent: () => true, send, log: makeLog().log });
    await fill.settled;
    expect(send.mock.calls[0][0]).toEqual([{ ...eng, url: "/cache/eng.srt", selected: true }]);
  });

  it("releases a sidecar once it is in mpv or its fetch failed, so a later pick takes the normal path", async () => {
    const engFetch = deferred<Array<{ url: string }>>();
    const czeFetch = deferred<Array<{ url: string }>>();
    const sent = deferred<void>();
    const cache = (entries: SubtitleSidecar[]) => (entries[0] === eng ? engFetch.promise : czeFetch.promise);
    const send = vi.fn(() => sent.promise);
    const fill = fillLateSidecars({ ready: [], pending: [eng, cze], cache, stillSelected: () => true, isCurrent: () => true, send, log: makeLog().log });
    engFetch.resolve([{ url: "/cache/eng.srt" }]);
    czeFetch.resolve([{ url: "" }]);
    await flush();
    console.log("[test] owns while sending", { eng: fill.owns(eng.url), cze: fill.owns(cze.url) });
    expect(fill.owns(eng.url)).toBe(true);
    expect(fill.owns(cze.url)).toBe(false);
    sent.resolve();
    await fill.settled;
    expect(fill.owns(eng.url)).toBe(false);
  });
});
