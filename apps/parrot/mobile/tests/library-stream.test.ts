/**
 * PAR-SYNC-01: the open phone follows the library stream (LIB-SYNC-05/09) and hears of every newer snapshot, so a
 * photo, a name or a heart saved on the desktop shows in seconds instead of at the next start.
 * @req PAR-SYNC-01[parrot]
 */
import { describe, expect, it } from "vitest";
import { followLibrarySnapshots, parseSnapshotVersion, readStreamEvents, streamRetryDelay, type StreamRequest } from "../src/lib/libraryStream";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-LIBRARY-STREAM-001] phase=${phase}`, JSON.stringify(detail));

/** A stand-in for React Native's XMLHttpRequest that hands the body over in pieces, as the stream arrives. */
class FakeRequest implements StreamRequest {
  readyState = 0;
  status = 0;
  responseText = "";
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url = "";
  headers: Record<string, string> = {};
  aborted = false;
  open(_method: string, url: string) {
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
  abort() {
    this.aborted = true;
  }
  push(text: string) {
    this.status = 200;
    this.readyState = 3;
    this.responseText += text;
    this.onreadystatechange?.();
  }
  close(status = 200) {
    this.status = status;
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

const meta = (version: number, snapshotVersion?: number) => `data: ${JSON.stringify({ exists: true, version, snapshotVersion, sizeBytes: 1, updatedAt: null })}\n\n`;

const follow = () => {
  const requests: FakeRequest[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const seen: number[] = [];
  const stop = followLibrarySnapshots({
    apiBaseUrl: "https://api.example.test/",
    token: "tok en",
    onSnapshot: (version) => seen.push(version),
    request: () => {
      const request = new FakeRequest();
      requests.push(request);
      return request;
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
  });
  return { requests, timers, seen, stop };
};

describe("PARROT-MOBILE-LIBRARY-STREAM-001 reading the stream", () => {
  it("takes the newest snapshot's version from a status, the version when there is no snapshot version, nothing from anything else", () => {
    expect(parseSnapshotVersion(JSON.stringify({ exists: true, version: 9, snapshotVersion: 7 }))).toBe(7);
    expect(parseSnapshotVersion(JSON.stringify({ exists: true, version: 9 }))).toBe(9);
    expect(parseSnapshotVersion(JSON.stringify({ exists: false, version: 0 }))).toBeNull();
    expect(parseSnapshotVersion("{}")).toBeNull();
    expect(parseSnapshotVersion("not json")).toBeNull();
  });

  it("splits complete events, keeps a half-arrived one for later and skips the keep-alive ping", () => {
    const { messages, rest } = readStreamEvents('event: ping\ndata: {}\n\ndata: {"a":1}\r\n\r\ndata: {"b"');
    expect(messages).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b"');
  });

  it("waits 1 s, 2 s, 4 s … and never more than 30 s before connecting again", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(streamRetryDelay)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });
});

describe("PARROT-MOBILE-LIBRARY-STREAM-001 following the library while the app is open", () => {
  it("connects to the account's Parrot stream and reports every status, even one split over two pieces", () => {
    const { requests, seen } = follow();
    const [request] = requests;
    expect(request!.url).toBe("https://api.example.test/library/db/stream?token=tok%20en&app=parrot");
    expect(request!.headers.Accept).toBe("text/event-stream");
    request!.push(meta(41, 40));
    // The desktop saves the artist's new photo: the status arrives in two pieces.
    const next = meta(43, 43);
    request!.push(next.slice(0, 20));
    expect(seen).toEqual([40]);
    request!.push(next.slice(20));
    request!.push("event: ping\ndata: {}\n\n");
    log("seen", { seen });
    expect(seen).toEqual([40, 43]);
  });

  it("connects again after the API ends the stream or it fails, and starts the wait over once a status arrives", () => {
    const { requests, timers, seen } = follow();
    requests[0]!.onerror?.();
    expect(timers.map((timer) => timer.ms)).toEqual([1000]);
    timers[0]!.run();
    requests[1]!.close(502);
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
    timers[1]!.run();
    requests[2]!.push(meta(5));
    requests[2]!.close();
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000, 1000]);
    timers[2]!.run();
    requests[3]!.push(meta(6));
    log("reconnects", { requests: requests.length, seen });
    expect(requests).toHaveLength(4);
    expect(seen).toEqual([5, 6]);
  });

  it("stops: the open stream is aborted, a waiting reconnect never runs, and a late piece is not reported", () => {
    const first = follow();
    first.requests[0]!.push(meta(1));
    first.stop();
    expect(first.requests[0]!.aborted).toBe(true);
    first.requests[0]!.push(meta(2));
    first.requests[0]!.close();
    expect(first.seen).toEqual([1]);
    expect(first.timers).toHaveLength(0);

    const second = follow();
    second.requests[0]!.onerror?.();
    second.stop();
    expect(second.timers[0]!.cleared).toBe(true);
    expect(second.requests).toHaveLength(1);
  });
});
