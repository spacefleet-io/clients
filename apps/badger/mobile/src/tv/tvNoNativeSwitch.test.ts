/**
 * TV-NO-NATIVE-SWITCH-001 (REL-LOG-06, UX-TV-13, UX-TV-34). tvOS has no UISwitch: react-native-tvos registers no native
 * `Switch` component on Apple TV, so mounting one draws "UnimplementedView: native component 'Switch' is not
 * registered" (a red box in a debug build). TV Settings drew each on/off setting (error reports, autoplay, …) with
 * react-native's `Switch`, so opening Settings on the Apple TV "sejour" red-boxed (XCUITest testTvFeatures, staging
 * 6770cbb77, 2026-11-13). On/off state on TV is the family's drawn pill toggle (TvToggle, UX-TV-34) on every TV.
 * This scans every TV source file, whichever file draws the settings rows, for react-native's Switch.
 *
 * @bugfix @regression-proof
 * @req REL-LOG-06[badger-tv]
 * @req UX-TV-13[badger-tv]
 * @req UX-TV-34[badger-tv]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TAG = "[TV-NO-NATIVE-SWITCH-001]";

/** `import { …, Switch, … } from "react-native"` (any line breaks), or `Switch` read off a react-native namespace. */
const NAMED_IMPORT = /import\s*(?:type\s*)?\{[^}]*\bSwitch\b[^}]*\}\s*from\s*["']react-native["']/;
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+(\w+)\s+from\s*["']react-native["']/;

describe("TV app on Apple TV (TV-NO-NATIVE-SWITCH-001)", () => {
  it("@bugfix @regression-proof no TV source file draws react-native's Switch, which tvOS does not have", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(__dirname);
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      const namespace = NAMESPACE_IMPORT.exec(source)?.[1];
      return NAMED_IMPORT.test(source) || (namespace !== undefined && new RegExp(`\\b${namespace}\\.Switch\\b`).test(source));
    });
    console.info(TAG, "scan", JSON.stringify({ scanned: files.length, offenders: offenders.map((file) => relative(__dirname, file)) }));
    expect(files.length).toBeGreaterThan(20);
    expect(offenders.map((file) => relative(__dirname, file))).toEqual([]);
  });
});
