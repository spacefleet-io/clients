/**
 * @test-id error-report-caught-and-tags
 * @level unit
 *
 * REL-LOG-06 (Chris 2026-11-10): every report names its app and platform, and an error a crash guard catches
 * (UX-CRASH-01) is reported while reporting is on, and goes nowhere while it is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  close: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/react-native", () => sdk);

import { reportCaughtError, setCaughtErrorSink } from "../src/caught";
import { createReporterOptions } from "../src/options";
import { createReactNativeReporting } from "../src/reactNative";
import { scrubErrorEvent } from "../src/scrub";

const DSN = "https://key@reports.example.test/2";
const APPS = "[badger-desktop] @req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot]";
const errorEvent = (tags: Record<string, unknown>) => ({
  event_id: "abcdef0123456789abcdef0123456789",
  platform: "javascript",
  level: "error",
  release: "1.2.3",
  exception: { values: [{ type: "TypeError", value: "x is undefined" }] },
  tags,
});

beforeEach(() => {
  sdk.init.mockReset();
  sdk.close.mockReset().mockResolvedValue(true);
  sdk.captureException.mockReset();
  setCaughtErrorSink(undefined);
});

describe("report tags", () => {
  // @req REL-LOG-06[badger-desktop] @req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot]
  it(`@req REL-LOG-06${APPS} sets the app and platform tags on every SDK instance`, () => {
    const options = createReporterOptions({ dsn: DSN, release: "1.2.3", app: "parrot", platform: "phone" });
    console.info("[tags-test] initialScope =", JSON.stringify(options.initialScope));
    expect(options.initialScope).toEqual({ tags: { app: "parrot", platform: "phone" } });
    expect(createReporterOptions({ dsn: DSN, release: "1.2.3" })).not.toHaveProperty("initialScope");
  });

  // @req REL-LOG-06[badger-desktop] @req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot]
  it(`@req REL-LOG-06${APPS} keeps only the app, platform and guard tags, with short fixed values`, () => {
    const out = scrubErrorEvent(
      errorEvent({ app: "badger", platform: "tv", guard: "popup", title: "Blade Runner", route: "/media/42", platformx: "y" }),
    ) as { tags?: Record<string, string> };
    console.info("[tags-test] kept tags =", JSON.stringify(out.tags));
    expect(out.tags).toEqual({ app: "badger", platform: "tv", guard: "popup" });
    const odd = scrubErrorEvent(errorEvent({ app: "Badger /home/chris", guard: "x".repeat(40) })) as object;
    expect(odd).not.toHaveProperty("tags");
  });
});

describe("errors caught by the crash guards", () => {
  it("go nowhere while no reporter is running, and never throw into the guard", () => {
    expect(() => reportCaughtError(new Error("boom"), "section")).not.toThrow();
    setCaughtErrorSink(() => {
      throw new Error("sink broke");
    });
    expect(() => reportCaughtError(new Error("boom"), "section")).not.toThrow();
  });

  // @req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot]
  it("@req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot] are captured only while the phone reporter is on", async () => {
    const reporting = createReactNativeReporting({ dsn: DSN, release: "1.2.3", app: "badger", platform: "tv" });
    reportCaughtError(new Error("before opt-in"), "item");
    expect(sdk.captureException).not.toHaveBeenCalled();

    await reporting.setEnabled(true);
    expect(sdk.init.mock.calls[0][0].initialScope).toEqual({ tags: { app: "badger", platform: "tv" } });
    const crash = new Error("boom in a row");
    reportCaughtError(crash, "section");
    console.info("[caught-test] captures while on =", sdk.captureException.mock.calls.length);
    expect(sdk.captureException).toHaveBeenCalledWith(crash, { tags: { guard: "section" } });

    await reporting.setEnabled(false);
    reportCaughtError(new Error("after opt-out"), "popup");
    console.info("[caught-test] captures after off =", sdk.captureException.mock.calls.length);
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });
});
