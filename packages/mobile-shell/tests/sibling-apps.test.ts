/**
 * @test-id MOBILE-SHELL-SIBLING-APPS-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile,parrot]
 * @why On Android the sister app is trusted by its package AND its signing certificate. The release certificates the
 *   native check accepts (`SiblingApps.kt`) must be exactly the Play app-signing and upload keys the website publishes
 *   for Badger and Parrot (its `.well-known/assetlinks.json`, checked against this same table on the website's side):
 *   a new signing key added to one and not the other would either break same-device sign-in or trust a stranger's build.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SUITE = "[sibling-apps]";
const ROOT = resolve(__dirname, "../../..");
const KOTLIN = resolve(ROOT, "packages/mobile-sibling/android/src/main/java/io/spacefleet/sibling/SiblingApps.kt");

/** The release certificates the website publishes in its assetlinks.json, per package (sorted). */
const PUBLISHED: Record<string, string[]> = {
  "com.spacebadger.mobile": [
    "19:C4:BE:45:4F:DF:A4:A4:EE:1E:9D:AC:05:3B:1C:2E:26:9F:78:8B:95:30:1B:A3:C9:1A:1A:47:96:62:F8:C4",
    "E1:9D:41:0E:23:4F:53:E2:68:ED:07:4A:23:84:EB:2A:1B:62:D3:3A:E0:DC:80:D2:BB:72:ED:B2:D2:2F:0E:D4",
  ],
  "io.spacefleet.parrot": [
    "AE:89:9D:1B:E0:1C:9B:3D:76:4F:FC:33:95:2C:80:41:5A:10:5F:5B:7A:90:72:E1:16:18:1C:D1:D6:60:54:3C",
    "B2:E1:65:79:B4:E1:EB:B9:08:A1:57:49:92:76:54:43:F4:FE:EF:A6:91:1E:68:A8:36:79:3E:26:27:A3:B2:6C",
  ],
};

const kotlinCerts = (): Record<string, string[]> => {
  const source = readFileSync(KOTLIN, "utf8");
  const packages = Object.fromEntries([...source.matchAll(/const val (\w+) = "([\w.]+)"/g)].map((m) => [m[1], m[2]]));
  const table = source.slice(source.indexOf("RELEASE_CERTS"));
  const certs: Record<string, string[]> = {};
  for (const entry of table.matchAll(/(\w+) to setOf\(([^)]*)\)/g)) {
    const name = packages[entry[1]];
    if (name) certs[name] = [...entry[2].matchAll(/"([0-9A-F:]+)"/g)].map((m) => m[1]).sort();
  }
  return certs;
};

describe("SiblingApps.kt", () => {
  it("accepts exactly the release certificates the website publishes for Badger and Parrot", () => {
    const native = kotlinCerts();
    console.info(SUITE, { published: Object.keys(PUBLISHED), native: Object.keys(native) });
    expect(Object.keys(native).sort()).toEqual(["com.spacebadger.mobile", "io.spacefleet.parrot"]);
    for (const certs of Object.values(native)) for (const fp of certs) expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
    expect(native).toEqual(PUBLISHED);
  });
});
