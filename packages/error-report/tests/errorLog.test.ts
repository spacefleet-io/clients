/**
 * UX-SUP-05 / REL-LOG-06: the error log every app attaches to feedback (only when the user ticks it) keeps the newest
 * warning and error lines and scrubs each line as it is recorded, so nothing personal ever sits in it.
 */
import { describe, expect, it } from "vitest";
import { createErrorLog, ERROR_LOG_LINES } from "../src/errorLog";

const P = "[error-log]";
const fixedNow = () => new Date("2026-11-07T10:00:00.000Z");

describe("@req UX-SUP-05[badger-mobile,parrot] the shared error log is cleaned as it is recorded", () => {
  it("formats one timestamped line per record, oldest first", () => {
    const log = createErrorLog({ now: fixedNow });
    log.record("warn", "player", "buffer underrun");
    log.record("error", "sync", "upload failed");
    const text = log.read();
    console.info(`${P} phase=format log=\n${text}`);
    expect(text).toBe(
      "2026-11-07T10:00:00.000Z [WARN] [player] buffer underrun\n2026-11-07T10:00:00.000Z [ERROR] [sync] upload failed",
    );
  });

  it("drops addresses, home paths and emails before they reach the log", () => {
    const log = createErrorLog({ now: fixedNow });
    log.record("error", "api", "GET https://api.spacefleet.io/v1/media?token=abc failed for chris@example.com");
    log.record("error", "fs", "could not open /home/chris/Videos/Holiday 2025.mkv");
    log.record("warn", "net", "peer 192.168.0.20 refused");
    const text = log.read();
    console.info(`${P} phase=scrub log=\n${text}`);
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("chris@example.com");
    expect(text).not.toContain("/home/chris");
    expect(text).not.toContain("Holiday 2025");
    expect(text).not.toContain("192.168.0.20");
    expect(text.split("\n")).toHaveLength(3);
  });

  it("keeps only the newest lines", () => {
    const log = createErrorLog({ maxLines: 3, now: fixedNow });
    for (let i = 1; i <= 5; i += 1) log.record("error", "loop", `failure ${i}`);
    const lines = log.read().split("\n");
    console.info(`${P} phase=cap kept=${lines.length} default=${ERROR_LOG_LINES}`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("failure 3");
    expect(lines[2]).toContain("failure 5");
    expect(ERROR_LOG_LINES).toBe(500);
  });

  it("an empty log reads as an empty string", () => {
    expect(createErrorLog().read()).toBe("");
  });
});
