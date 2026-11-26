import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { appendFileSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { rotateLogIfLarge, RUNTIME_LOG_KEEP_FILES, RUNTIME_LOG_MAX_BYTES } from "@space/runtime-host/logRotation";

describe("runtime.log rotation (guardian side)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  // @req RT-LOG-02
  it("keeps at most 5 files of 10 MB and loses no recent line", () => {
    dir = mkdtempSync(path.join(tmpdir(), "runtime-log-rotation-"));
    const log = path.join(dir, "runtime.log");
    expect(RUNTIME_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(RUNTIME_LOG_KEEP_FILES).toBe(5);

    // A small limit stands in for 10 MB; the logic is the same.
    const options = { maxBytes: 100, keepFiles: RUNTIME_LOG_KEEP_FILES };
    expect(rotateLogIfLarge(log, options)).toBe(false); // no file yet

    // The runtime keeps one append-mode fd for its whole life.
    const fd = openSync(log, "a");
    let rotations = 0;
    for (let i = 0; i < 40; i++) {
      writeSync(fd, `line-${String(i).padStart(3, "0")} ${"x".repeat(40)}\n`);
      if (rotateLogIfLarge(log, options)) rotations++;
    }
    closeSync(fd);

    const files = readdirSync(dir).sort();
    console.info(`[runtime-log-rotation] rotations=${rotations} files=${JSON.stringify(files)} sizes=${files.map((f) => statSync(path.join(dir, f)).size)}`);
    expect(files).toEqual(["runtime.log", "runtime.log.1", "runtime.log.2", "runtime.log.3", "runtime.log.4"]);
    expect(rotations).toBeGreaterThan(4);
    // The newest lines are in the newest files, the live fd kept writing after truncation.
    const newest = readFileSync(`${log}.1`, "utf8") + readFileSync(log, "utf8");
    expect(newest).toContain("line-039");
    // Nothing exceeds the limit by more than one line.
    for (const f of files) expect(statSync(path.join(dir, f)).size).toBeLessThan(100 + 60);
    // The oldest were dropped (rotation, bounded), the recent ones survive in order.
    expect(existsSync(`${log}.5`)).toBe(false);
    expect(readFileSync(`${log}.4`, "utf8")).not.toContain("line-000");
  });

  // @req RT-LOG-02
  it("skips while another guardian holds the rotation lock, and clears a stale lock", () => {
    dir = mkdtempSync(path.join(tmpdir(), "runtime-log-rotation-lock-"));
    const log = path.join(dir, "runtime.log");
    writeFileSync(log, "x".repeat(200));
    writeFileSync(`${log}.rotate.lock`, "");
    expect(rotateLogIfLarge(log, { maxBytes: 100 })).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${log}.rotate.lock`, old, old);
    expect(rotateLogIfLarge(log, { maxBytes: 100 })).toBe(false); // clears the stale lock, rotates on the next tick
    expect(existsSync(`${log}.rotate.lock`)).toBe(false);
    expect(rotateLogIfLarge(log, { maxBytes: 100 })).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(200);
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.rotate.lock`)).toBe(false);
  });

  // @req RT-LOG-02
  it("does nothing below the limit and never throws on an unreadable path", () => {
    dir = mkdtempSync(path.join(tmpdir(), "runtime-log-rotation-small-"));
    const log = path.join(dir, "runtime.log");
    writeFileSync(log, "short\n");
    appendFileSync(log, "more\n");
    expect(rotateLogIfLarge(log)).toBe(false);
    expect(readdirSync(dir)).toEqual(["runtime.log"]);
    expect(rotateLogIfLarge(path.join(dir, "missing", "runtime.log"))).toBe(false);
  });
});
