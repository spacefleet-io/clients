/**
 * @test-id PARROT-MOBILE-FEEDBACK-001
 * @level unit
 * @why Closed testers report problems from the app (REL-LAUNCH-06); a message sent to the wrong route, without the
 *   account's token or tagged as another app, never reaches the team's feedback inbox. Like Badger (REL-FAM-03), the
 *   error log goes along only when the user ticked the box, and it carries no address, path or account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { buildFeedback } from "@space/mobile-shell/feedback";
import { readErrorLog, scopeLogger } from "@space/mobile-shell/logger";
import { parrotFeedbackDevice, sendParrotFeedback } from "../src/lib/feedback";
import packageJson from "../package.json";

const P = "[parrot-feedback]";

// The shared device line (`@space/mobile-shell/feedback-device`) reads the phone from React Native's Platform.
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 36, constants: { Release: "16", Model: "Pixel 8", Manufacturer: "Google" } },
}));

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    calls.push(input);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  });
  return calls;
};

/** What the shared form sends for a draft. */
const draftBody = (message: string, attachLog: boolean) => {
  const body = buildFeedback({ message, attachLog }, parrotFeedbackDevice(), readErrorLog);
  if (!body) throw new Error("empty draft");
  return body;
};

describe("@req UX-SUP-05[parrot] Parrot phone feedback", () => {
  it("posts the trimmed message as parrot-mobile with the session token and the app version, no log when unticked", async () => {
    scopeLogger("play").warn("play.start_failed", { message: "boom" });
    const calls = stubFetch(201, { id: "f1" });
    await sendParrotFeedback("tok", draftBody("  the album won't play  ", false));
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.spacefleet.io/feedback");
    expect(request.headers.get("authorization")).toBe("Bearer tok");
    expect(request.headers.get("x-space-app")).toBe("parrot");
    const sent = await request.json();
    console.info(`${P} phase=unticked body=${JSON.stringify(sent)}`);
    expect(sent).toEqual({
      message: "the album won't play",
      app: "parrot-mobile",
      appVersion: packageJson.version,
      platform: "android 16",
      deviceModel: "Google Pixel 8",
      log: null,
      requestIds: [],
    });
  });

  it("@req UX-SUP-02[parrot] @req PAR-SUP-01[parrot] ticked: sends the app's error log, cleaned of addresses, paths and accounts", async () => {
    const log = scopeLogger("library");
    log.warn("library.open_failed", { message: "GET https://storage.example.test/lib/abc?sig=secret failed for tester@example.com" });
    log.error("play.start_failed", { message: "ENOENT /storage/emulated/0/Music/Secret Album/01 Track.flac" });
    log.info("library.opened", { albums: 3 });
    const calls = stubFetch(201, { id: "f2" });
    await sendParrotFeedback("tok", draftBody("crash on play", true));
    const sent = await calls[0].json();
    console.info(`${P} phase=ticked log=\n${sent.log}`);
    expect(sent.log).toContain("[WARN] [library] library.open_failed");
    expect(sent.log).toContain("[ERROR] [library] play.start_failed");
    expect(sent.log).not.toContain("library.opened");
    expect(sent.log).not.toContain("sig=secret");
    expect(sent.log).not.toContain("tester@example.com");
    expect(sent.log).not.toContain("/storage/emulated/0/Music");
    expect(sent.log).not.toContain("Secret Album");
  });

  it("surfaces the API's refusal (rate limit) as an ApiError", async () => {
    stubFetch(429, { error: "rate_limited" });
    await expect(sendParrotFeedback("tok", draftBody("hi", false))).rejects.toBeInstanceOf(ApiError);
  });

  /** @req UX-SUP-07[parrot] */
  it("carries the server's request id of a call that failed before, through the app's own start-up wiring", async () => {
    const requestId = "3f2c9a1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";
    // `../src/config` (imported by the sender) wires `logApiFailuresOnDevice`, which remembers failed calls' ids.
    stubFetch(404, { error: "not_found" }, { "x-request-id": requestId });
    await sendParrotFeedback("tok", draftBody("first", false)).catch(() => undefined);
    const calls = stubFetch(201, { id: "f3" });
    await sendParrotFeedback("tok", draftBody("the sync failed", false));
    const sent = await calls[0].json();
    console.info(`${P} phase=request-ids body=${JSON.stringify(sent)}`);
    expect(sent.requestIds).toContain(requestId);
    expect(sent.log).toBeNull();
  });
});
