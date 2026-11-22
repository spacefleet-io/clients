/**
 * @test-id error-report-scrub
 * @level unit
 */
import { describe, expect, it } from "vitest";
import { normalizeScriptPath, resolveDsn, scrubErrorEvent, scrubText } from "../src";

const APPS = "[badger-desktop,badger-mobile]";

/** An event the way an SDK builds it, loaded with everything REL-LOG-06 forbids. */
function leakyEvent() {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_760_000_000.5,
    platform: "javascript",
    level: "error",
    release: "1.4.2",
    environment: "production",
    server_name: "chris-laptop",
    transaction: "/library/movies/Blade Runner 2049",
    user: { id: "u_123", email: "chris@example.com", ip_address: "203.0.113.9", username: "chris" },
    request: { url: "https://api.spacebadger.io/library/items/4f1e2d3c-1111-2222-3333-444455556666?title=Heat", headers: { cookie: "sid=abc" } },
    tags: { title: "Blade Runner 2049", account: "acct_77" },
    extra: { title: "Blade Runner 2049", file: "/home/chris/Videos/Blade Runner 2049.mkv" },
    breadcrumbs: [{ category: "navigation", message: "to /library/movies/Heat" }],
    contexts: {
      os: { name: "Linux", version: "6.7.1", kernel_version: "6.7.1-arch1", build: "x" },
      runtime: { name: "Electron", version: "44.7.0" },
      app: { app_version: "1.4.2", app_name: "Badger", app_start_time: "x" },
      device: { model: "ThinkPad", family: "x", name: "chris-laptop" },
      culture: { locale: "fr-FR", timezone: "Europe/Paris" },
    },
    sdk: { name: "sentry.javascript.electron", version: "8.3.0", packages: [{ name: "npm:@sentry/electron" }] },
    debug_meta: { images: [{ type: "sourcemap", code_file: "file:///home/chris/.local/share/badger/resources/app.asar/out/main/index-3f9a.js", debug_id: "aaaa-bbbb" }] },
    exception: {
      values: [
        {
          type: "Error",
          value: "ENOENT: no such file or directory, open '/home/chris/Videos/Blade Runner 2049.mkv'",
          mechanism: { type: "onuncaughtexception", handled: false, data: { file: "/x/y" } },
          stacktrace: {
            frames: [
              {
                filename: "file:///home/chris/.local/share/badger/resources/app.asar/out/main/index-3f9a.js",
                abs_path: "file:///home/chris/.local/share/badger/resources/app.asar/out/main/index-3f9a.js",
                function: "openMedia",
                lineno: 120,
                colno: 7,
                in_app: true,
                module: "home.chris.Videos",
                context_line: "const title = 'Blade Runner 2049';",
                pre_context: ["a"],
                post_context: ["b"],
                vars: { title: "Blade Runner 2049" },
              },
            ],
          },
        },
      ],
    },
  };
}

describe("error report scrubber", () => {
  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} removes a file path from the message and from every stack frame`, () => {
    const event = scrubErrorEvent(leakyEvent());
    const json = JSON.stringify(event);
    console.info("[scrub-test] scrubbed event:", json);

    expect(event).not.toBeNull();
    expect(json).not.toContain("/home/chris");
    expect(json).not.toContain("Videos");
    expect(json).not.toContain(".mkv");
    expect(json).not.toContain("app.asar");
    const frame = (event as ReturnType<typeof leakyEvent>).exception.values[0]!.stacktrace.frames[0]!;
    expect(frame).toMatchObject({ filename: "app:///index-3f9a.js", abs_path: "app:///index-3f9a.js", function: "openMedia", lineno: 120, colno: 7, in_app: true });
    expect(frame).not.toHaveProperty("context_line");
    expect(frame).not.toHaveProperty("vars");
    expect(frame).not.toHaveProperty("module");
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} removes a media title wherever the SDK put it`, () => {
    const event = scrubErrorEvent(leakyEvent());
    const json = JSON.stringify(event);

    expect(json).not.toContain("Blade Runner");
    expect(json).not.toContain("Heat");
    expect(event).not.toHaveProperty("transaction");
    expect(event).not.toHaveProperty("tags");
    expect(event).not.toHaveProperty("extra");
    expect(event).not.toHaveProperty("breadcrumbs");
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} removes user, account, request, address and device details`, () => {
    const event = scrubErrorEvent(leakyEvent());
    const json = JSON.stringify(event);

    for (const leaked of ["chris@example.com", "u_123", "203.0.113.9", "acct_77", "chris-laptop", "api.spacebadger.io", "4f1e2d3c", "ThinkPad", "fr-FR", "Europe/Paris", "sid=abc"]) {
      expect(json, `leaked ${leaked}`).not.toContain(leaked);
    }
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("server_name");
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} keeps the error, the stack, the app version and the operating system`, () => {
    const event = scrubErrorEvent(leakyEvent()) as ReturnType<typeof leakyEvent>;

    expect(event.release).toBe("1.4.2");
    expect(event.contexts).toEqual({
      os: { name: "Linux", version: "6.7.1" },
      runtime: { name: "Electron", version: "44.7.0" },
      app: { app_version: "1.4.2" },
    });
    expect(event.exception.values[0]!.type).toBe("Error");
    expect(event.exception.values[0]!.value).toContain("ENOENT");
    expect(event.exception.values[0]!.mechanism).toEqual({ type: "onuncaughtexception", handled: false });
    expect(event.debug_meta.images).toEqual([{ type: "sourcemap", code_file: "app:///index-3f9a.js", debug_id: "aaaa-bbbb" }]);
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} drops an event that holds no error`, () => {
    expect(scrubErrorEvent({ event_id: "x", user: { id: "1" } })).toBeNull();
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} scrubs paths, urls, quoted titles, addresses and ids out of free text`, () => {
    const cases: Array<[string, string[]]> = [
      ["Cannot play 'Dune Part Two (2024).mkv'", ["Dune", "2024"]],
      ['Failed to load "Alien"', ["Alien"]],
      ["open /media/Movies/Dune Part Two.mkv failed", ["Dune", "Movies"]],
      ["read C:\\Users\\Chris\\Videos\\Dune.mkv: access denied", ["Chris", "Dune"]],
      ["GET https://api.spacebadger.io/library/items/1234567 failed", ["spacebadger", "1234567"]],
      ["file:///home/chris/x.js not found", ["chris"]],
      ["user chris@example.com not found", ["chris@example.com"]],
      ["connect ECONNREFUSED 192.168.0.20:8080", ["192.168.0.20"]],
      ["bad id 4f1e2d3c-1111-2222-3333-444455556666", ["4f1e2d3c"]],
      ["bad hash deadbeef0123", ["deadbeef0123"]],
      ["open Movies/Dune Part Two.mkv failed", ["Dune", "Movies", "Part Two"]],
      ["failed to probe Dune.Part.Two.2024.mkv", ["Dune", "mkv"]],
    ];
    for (const [input, forbidden] of cases) {
      const output = scrubText(input);
      console.info(`[scrub-test] ${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
      for (const word of forbidden) expect(output, input).not.toContain(word);
    }
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} keeps the readable part of an ordinary error message`, () => {
    expect(scrubText("Cannot read properties of undefined")).toBe("Cannot read properties of undefined");
    expect(scrubText("x is not a function")).toBe("x is not a function");
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} removes a title written into a message without quotes`, () => {
    const cases: Array<[string, string[]]> = [
      ["Cannot open Blade Runner 2049 (2017) 2160p", ["Blade", "Runner", "2049", "2017", "2160p"]],
      ["Metadata lookup failed for Dune: Part Two", ["Dune", "Part", "Two"]],
      ["Heat failed to load", ["Heat"]],
      ["Cannot play Network", ["Network"]],
      ["Playback error: Amélie stalled at 00:42", ["Amélie"]],
      ["Cannot resume 千と千尋の神隠し", ["千と千尋の神隠し"]],
      ["No subtitles for The Office S03E07", ["Office", "S03E07"]],
      ["Artwork missing for M3GAN", ["M3GAN"]],
    ];
    for (const [input, forbidden] of cases) {
      const output = scrubText(input);
      console.info(`[scrub-test] G0 ${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
      for (const word of forbidden) expect(output, input).not.toContain(word);
    }
    // The same message thrown by the app and carried by an SDK event.
    const event = scrubErrorEvent({
      exception: { values: [{ type: "Error", value: "Cannot open Blade Runner 2049 (2017) 2160p" }] },
    });
    console.info(`[scrub-test] G0 event -> ${JSON.stringify(event)}`);
    expect(JSON.stringify(event)).not.toMatch(/Blade|Runner|2160p/);
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} keeps the error words of common runtime messages`, () => {
    const kept: Array<[string, string]> = [
      ["Network request failed", "Network request failed"],
      ["TypeError: Failed to fetch", "TypeError: Failed to fetch"],
      ["Maximum call stack size exceeded", "Maximum call stack size exceeded"],
      ["SQLITE_BUSY: database is locked", "SQLITE_BUSY: database is locked"],
      ["Request failed with status code 409", "Request failed with status code 409"],
      ["Cannot read properties of undefined (reading 'title')", "Cannot read properties of undefined (reading <redacted>)"],
      ["LibraryVersionDowngradeError: library is newer", "LibraryVersionDowngradeError: library is newer"],
    ];
    for (const [input, expected] of kept) {
      const output = scrubText(input);
      console.info(`[scrub-test] G0-keep ${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
      expect(output, input).toBe(expected);
    }
  });

  it("caps the message length", () => {
    expect(scrubText("a".repeat(2000)).length).toBeLessThan(310);
  });

  it("reduces any script location to a bundle name", () => {
    expect(normalizeScriptPath("/home/chris/app/out/renderer/assets/index-9f.js?x=1#y")).toBe("app:///index-9f.js");
    expect(normalizeScriptPath("C:\\Users\\Chris\\app\\main.js")).toBe("app:///main.js");
    expect(normalizeScriptPath("")).toBe("app:///unknown");
  });
});

describe("DSN from the build", () => {
  it("accepts an https DSN with a key and a project id", () => {
    expect(resolveDsn("https://abc123@reports.spacefleet.io/4")).toBe("https://abc123@reports.spacefleet.io/4");
  });

  it("treats anything else as 'this build cannot report'", () => {
    for (const bad of [undefined, "", "   ", "http://abc@reports.spacefleet.io/4", "https://reports.spacefleet.io/4", "https://abc@reports.spacefleet.io/", "nonsense", 7]) {
      expect(resolveDsn(bad), String(bad)).toBeNull();
    }
  });
});
