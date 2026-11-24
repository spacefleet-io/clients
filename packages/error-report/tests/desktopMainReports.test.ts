/**
 * @test-id error-report-desktop-main-reports
 * @level unit
 *
 * REL-LOG-06 + REL-FAM-03: Badger and Parrot wire their main-process error reports through one factory. It keeps the
 * answer in `<userData>/error-reports.json` (the file both apps always used), tags reports with the app, never starts
 * the SDK before "on" or in a build without a reporting address, and `SF_ERROR_REPORTS=off` answers for one run.
 * The Electron SDK is a recorder; the consent file and the opt-in gate are the real code.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The part of the SDK's init options these tests read. */
type InitOptions = { release?: string; initialScope?: { tags?: Record<string, string> } };
const calls = vi.hoisted(() => ({ init: [] as InitOptions[] }));

vi.mock("@sentry/electron/main", () => ({
  init: (options: InitOptions) => calls.init.push(options),
  IPCMode: { Classic: 2 },
  makeElectronTransport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
}));

import { createConsentFile } from "../src/consentFile";
import { createDesktopErrorReports, type DesktopErrorReportsDeps } from "../src/desktopMainReports";

const P = "[desktop-main-reports]";
const DSN = "https://key@errors.example.test/1";

describe("@req REL-LOG-06 @req REL-FAM-03 one error-reports factory for both desktop apps", () => {
  let dir: string;
  let lines: string[];
  const deps = (over: Partial<DesktopErrorReportsDeps>): DesktopErrorReportsDeps => ({
    app: "badger",
    userDataDir: dir,
    dsn: DSN,
    release: "1.2.3",
    forcedRaw: undefined,
    log: (line) => {
      lines.push(line);
      console.info(`${P} log: ${line}`);
    },
    logError: (line) => {
      lines.push(`ERROR ${line}`);
      console.info(`${P} error: ${line}`);
    },
    ...over,
  });
  const consentPath = () => join(dir, "error-reports.json");
  const dump = (phase: string) =>
    console.info(`${P} ${phase}: file=${existsSync(consentPath()) ? readFileSync(consentPath(), "utf8").trim() : "(none)"} init=${calls.init.length} tags=${JSON.stringify(calls.init.map((o) => o.initialScope?.tags))}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desktop-main-reports-"));
    lines = [];
    calls.init.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const app of ["badger", "parrot"] as const) {
    it(`${app}: undecided starts nothing; "on" is stored in <userData>/error-reports.json and starts the SDK tagged ${app}`, async () => {
      const reports = createDesktopErrorReports(deps({ app }));
      await reports.start();
      dump("fresh");
      expect(reports.getState()).toEqual({ decision: "undecided", available: true, release: "1.2.3" });
      expect(calls.init).toHaveLength(0);

      await reports.setDecision("on");
      dump("after on");
      expect(JSON.parse(readFileSync(consentPath(), "utf8"))).toEqual({ version: 1, decision: "on" });
      expect(calls.init).toHaveLength(1);
      expect(calls.init[0]?.initialScope?.tags).toEqual({ app, platform: "desktop" });
      expect(calls.init[0]?.release).toBe("1.2.3");
    });
  }

  it("reads an answer stored before the share (same file, same format)", async () => {
    createConsentFile(consentPath()).write("on");
    const reports = createDesktopErrorReports(deps({ app: "parrot" }));
    await reports.start();
    dump("stored on");
    expect(reports.getState().decision).toBe("on");
    expect(calls.init).toHaveLength(1);
  });

  it("never starts the SDK in a build without a reporting address, even after on", async () => {
    const reports = createDesktopErrorReports(deps({ dsn: "" }));
    await reports.start();
    await reports.setDecision("on");
    dump("no dsn");
    expect(reports.getState()).toMatchObject({ decision: "on", available: false });
    expect(calls.init).toHaveLength(0);
  });

  it("SF_ERROR_REPORTS=off answers for the run without touching the stored answer", async () => {
    createConsentFile(consentPath()).write("on");
    const reports = createDesktopErrorReports(deps({ forcedRaw: "off" }));
    await reports.start();
    await reports.setDecision("on");
    dump("forced off");
    expect(reports.getState().decision).toBe("off");
    expect(calls.init).toHaveLength(0);
    expect(JSON.parse(readFileSync(consentPath(), "utf8"))).toEqual({ version: 1, decision: "on" });
    expect(lines.some((l) => l.includes("forced off"))).toBe(true);
  });
});
