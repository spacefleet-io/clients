/**
 * @test-id error-report-consent-file
 * @level unit
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsentFile } from "../src/consentFile";

const APPS = "[badger-desktop]";
const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-consent-"));
  dirs.push(dir);
  return join(dir, "nested", "error-reports.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("consent file", () => {
  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} is undecided, so never reports, until the user answers`, () => {
    expect(createConsentFile(tempPath()).read()).toBe("undecided");
  });

  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} remembers the answer across restarts`, () => {
    const path = tempPath();
    createConsentFile(path).write("on");
    expect(createConsentFile(path).read()).toBe("on");
    createConsentFile(path).write("off");
    expect(createConsentFile(path).read()).toBe("off");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} treats a damaged or foreign file as undecided`, () => {
    const path = tempPath();
    const file = createConsentFile(path);
    file.write("on");
    writeFileSync(path, "{not json");
    expect(file.read()).toBe("undecided");
    writeFileSync(path, JSON.stringify({ version: 2, decision: "on" }));
    expect(file.read()).toBe("undecided");
    expect(readFileSync(path, "utf8")).toContain('"version":2');
  });
});
