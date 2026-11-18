import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MISSING_BINARIES_MESSAGE,
  SETUP_BINARIES_COMMAND,
  missingBinariesReport,
} from "../src/main/missing-binaries";

const TAG = "[missing-binaries]";

describe("missingBinariesReport @req MPV-BIN-01", () => {
  it("returns null when ffmpeg, ffprobe and the bundled mpv are all present", () => {
    const input = { ffmpegPath: "/b/ffmpeg", ffprobePath: "/b/ffprobe", mpvKind: "bundled" };
    const report = missingBinariesReport(input);
    console.info(`${TAG} all present input=${JSON.stringify(input)} report=${JSON.stringify(report)}`);
    expect(report).toBeNull();
  });

  it("names every missing binary and the setup command", () => {
    const input = { ffmpegPath: undefined, ffprobePath: "", mpvKind: "fallback" };
    const report = missingBinariesReport(input);
    console.info(`${TAG} all missing input=${JSON.stringify(input)} report=${JSON.stringify(report)}`);
    expect(report).toEqual({
      missingBinaries: ["ffmpeg", "ffprobe", "mpv"],
      commands: ["bun run setup:binaries"],
    });
    expect(SETUP_BINARIES_COMMAND).toBe("bun run setup:binaries");
    expect(MISSING_BINARIES_MESSAGE).toContain("bun run setup:binaries");
  });

  it("treats an explicit mpv override as present", () => {
    const input = { ffmpegPath: "/b/ffmpeg", ffprobePath: undefined, mpvKind: "external" };
    const report = missingBinariesReport(input);
    console.info(`${TAG} override input=${JSON.stringify(input)} report=${JSON.stringify(report)}`);
    expect(report?.missingBinaries).toEqual(["ffprobe"]);
  });
});

describe("main process startup with missing binaries @req MPV-BIN-01", () => {
  it("@regression-proof logs an error and keeps starting instead of a modal + quit", () => {
    const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    const start = source.indexOf("missingBinariesReport(");
    const end = source.indexOf("screen.getPrimaryDisplay()", start);
    const block = start >= 0 && end > start ? source.slice(start, end) : "";
    console.info(`${TAG} startup block (chars ${start}..${end}):\n${block}`);
    expect(block).not.toBe("");
    expect(block).toContain("logger.error(");
    expect(block).toContain("MISSING_BINARIES_MESSAGE");
    expect(block).not.toContain("showErrorBox");
    expect(block).not.toContain("app.quit()");
    expect(block).not.toContain("return;");
    expect(source).not.toContain("Missing required binaries");
  });
});
