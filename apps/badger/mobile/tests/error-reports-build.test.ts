/**
 * @test-id MOBILE-ERRREPORT-002
 * @level unit
 * @why REL-LOG-06 for the phone and TV apps: the DSN is baked in at build time and never committed (a build without
 *   one cannot report), the TV app reports to its own project, nothing in the native layer starts the SDK by itself,
 *   and the settings/setup copy exists in every supported language.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const APP = join(__dirname, "..");
const REPO = join(APP, "..", "..", "..");
const platform = vi.hoisted(() => ({ isTV: false }));
vi.mock("react-native", () => ({ Platform: platform }));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};

const MOBILE_DSN = "https://aaaaaaaaaaaaaaaa@errors.example.test/11";
const TV_DSN = "https://bbbbbbbbbbbbbbbb@errors.example.test/12";

afterEach(() => {
  platform.isTV = false;
});

describe("DSN selection", () => {
  // @req REL-LOG-06[badger-mobile]
  it("the phone build uses the phone DSN and the TV build uses the TV DSN (Platform.isTV)", async () => {
    const { getBuildDsn, pickDsn } = await import("../src/lib/errorReportConfig");
    const generated = { BADGER_MOBILE_DSN: MOBILE_DSN, BADGER_TV_DSN: TV_DSN };

    platform.isTV = false;
    console.info("[error-reports-build] phone ->", getBuildDsn(generated));
    expect(getBuildDsn(generated)).toBe(MOBILE_DSN);

    platform.isTV = true;
    console.info("[error-reports-build] TV ->", getBuildDsn(generated));
    expect(getBuildDsn(generated)).toBe(TV_DSN);

    expect(pickDsn(generated, true)).toBe(TV_DSN);
    expect(pickDsn(generated, false)).toBe(MOBILE_DSN);
  });

  // @req REL-LOG-06[badger-mobile]
  it("a build that has no DSN for its app has an empty one, never the other app's", async () => {
    const { getBuildDsn } = await import("../src/lib/errorReportConfig");
    platform.isTV = true;
    expect(getBuildDsn({ BADGER_MOBILE_DSN: MOBILE_DSN })).toBe("");
    platform.isTV = false;
    expect(getBuildDsn({ BADGER_TV_DSN: TV_DSN })).toBe("");
    expect(getBuildDsn({})).toBe("");
  });

  // @req REL-LOG-06[badger-mobile]
  it("a fresh clone has no generated config: the build resolves to no DSN instead of failing", async () => {
    const { getBuildDsn } = await import("../src/lib/errorReportConfig");
    // Without `src/generated/errorReportConfig.ts` (gitignored) the optional require falls through to {}.
    expect(getBuildDsn()).toBe("");
  });
});

describe("write-error-report-config script", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // @req REL-LOG-06[badger-mobile]
  it("bakes both DSNs from the build environment into a module the app can read, empty when unset", async () => {
    const { writeErrorReportConfig, renderErrorReportConfig } = await import("../scripts/write-error-report-config");
    const dir = mkdtempSync(join(tmpdir(), "sf-error-report-config-"));
    dirs.push(dir);

    const full = join(dir, "full", "errorReportConfig.ts");
    writeErrorReportConfig({ SF_BUGSINK_DSN_BADGER_MOBILE: ` ${MOBILE_DSN}\n`, SF_BUGSINK_DSN_BADGER_TV: TV_DSN }, full);
    const loaded = await import(/* @vite-ignore */ full);
    console.info("[error-reports-build] generated module exports:", JSON.stringify({ ...loaded }));
    expect(loaded.BADGER_MOBILE_DSN).toBe(MOBILE_DSN);
    expect(loaded.BADGER_TV_DSN).toBe(TV_DSN);

    const empty = renderErrorReportConfig({});
    expect(empty).toContain('BADGER_MOBILE_DSN = ""');
    expect(empty).toContain('BADGER_TV_DSN = ""');

    const hostile = renderErrorReportConfig({ SF_BUGSINK_DSN_BADGER_MOBILE: '"; process.exit(1); //' });
    expect(hostile).toContain(JSON.stringify('"; process.exit(1); //'));
  });

  // @req REL-LOG-06[badger-mobile]
  it("the generated file is gitignored", () => {
    const ignore = readFileSync(join(APP, ".gitignore"), "utf8");
    expect(ignore.split("\n")).toContain("src/generated/");
  });
});

describe("no secret in the source", () => {
  // @req REL-LOG-06[badger-mobile]
  it("no DSN-looking string is committed in the app's source, entry files, scripts or docs", () => {
    const dsn = /https?:\/\/[0-9a-zA-Z]{8,}(?::[^@\s]*)?@[^\s"'`/]+\/\d+/;
    // Test files co-located in src/ (src/tv/**/*.test.tsx) carry fake fixture DSNs, like tests/ does; they never ship.
    const files = [
      ...walk(join(APP, "src")).filter(
        (f) => /\.(tsx?|jsx?|json)$/.test(f) && !/\.test\.[jt]sx?$/.test(f) && !f.includes(`${join("src", "generated")}`),
      ),
      ...walk(join(APP, "scripts")),
      join(APP, "index.js"),
      join(APP, "App.tsx"),
      join(APP, "README.md"),
      join(APP, "metro.config.js"),
    ];
    const hits = files.filter((file) => dsn.test(readFileSync(file, "utf8"))).map((f) => relative(REPO, f));
    console.info(`[error-reports-build] scanned ${files.length} files, DSN-looking hits: ${hits.length}`);
    expect(hits).toEqual([]);
  });
});

describe("nothing starts the SDK by itself", () => {
  // @req REL-LOG-06[badger-mobile]
  it("Android: the Sentry SDK is told not to auto-init", () => {
    const manifest = readFileSync(join(APP, "android/app/src/main/AndroidManifest.xml"), "utf8");
    expect(manifest).toMatch(/<meta-data android:name="io\.sentry\.auto-init" android:value="false" \/>/);
    expect(manifest).not.toMatch(/io\.sentry\.dsn/);
  });

  // @req REL-LOG-06[badger-mobile]
  it("iOS: no Sentry native start in the app delegate, and no Sentry upload build phase in either platform's build", () => {
    const iosFiles = [
      join(APP, "ios/SpaceBadgerMobile/AppDelegate.swift"),
      join(APP, "ios/Podfile"),
      join(APP, "ios/SpaceBadgerMobile.xcodeproj/project.pbxproj"),
      join(APP, "android/app/build.gradle"),
      join(APP, "android/build.gradle"),
    ];
    for (const file of iosFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/sentry/i);
  });

  // @req REL-LOG-06[badger-mobile]
  it("index.js starts error reporting after the polyfills and before the app mounts, and only through the opt-in gate", () => {
    const source = readFileSync(join(APP, "index.js"), "utf8");
    const polyfillsEnd = source.indexOf("// === END POLYFILLS ===");
    const start = source.indexOf("startErrorReporting()");
    const app = source.indexOf("require('./App')");
    console.info(`[error-reports-build] index.js offsets polyfillsEnd=${polyfillsEnd} start=${start} app=${app}`);
    expect(polyfillsEnd).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(polyfillsEnd);
    expect(app).toBeGreaterThan(start);
    expect(source).not.toMatch(/@sentry\//);
  });

  // @req REL-LOG-06[badger-mobile]
  it("the app code only reaches the SDK through @space/error-report (the opt-in gate)", () => {
    const offenders = walk(join(APP, "src"))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /from ["']@sentry\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("source map upload", () => {
  // @req REL-LOG-06[badger-mobile]
  it("metro.config.js loads the debug-ID plugin only for a build that asks for it", () => {
    const config = readFileSync(join(APP, "metro.config.js"), "utf8");
    expect(config).toContain("require('@space/error-report/metro').withErrorReportSourcemaps(merged, __dirname)");
    expect(config).not.toMatch(/require\(['"]@sentry\//);
  });
});

describe("copy", () => {
  // @req REL-LOG-06[badger-mobile]
  it("the setting and the setup question exist in every app language, with the same wording for the description", () => {
    const dir = join(REPO, "packages/mobile-shell/src/i18n");
    const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
    const fr = JSON.parse(readFileSync(join(dir, "fr.json"), "utf8"));
    const nl = JSON.parse(readFileSync(join(dir, "nl.json"), "utf8"));
    const de = JSON.parse(readFileSync(join(dir, "de.json"), "utf8"));
    const es = JSON.parse(readFileSync(join(dir, "es.json"), "utf8"));
    for (const [lang, bundle] of [["en", en], ["fr", fr], ["nl", nl], ["de", de], ["es", es]] as const) {
      console.info(`[error-reports-build] ${lang}:`, JSON.stringify(bundle.errorReports));
      expect(bundle.settings.privacy.title).toBeTruthy();
      expect(bundle.settings.privacy.errorReports.title).toBeTruthy();
      expect(bundle.errorReports.send).toBeTruthy();
      expect(bundle.errorReports.decline).toBeTruthy();
      expect(bundle.errorReports.description).toBe(bundle.settings.privacy.errorReports.description);
      // One short friendly line (Chris 2026-11-11): the details sit behind the "What's in a report?" link.
      expect(bundle.errorReports.description).toMatch(/an[oó]n.*🙂$/);
      expect(bundle.tvShell.errorReports.body).toBe(bundle.errorReports.description);
      expect(bundle.settings.privacy.errorReports.link).toBeTruthy();
    }
    expect(en.errorReports.description).toBe("Reports are anonymous and help us a lot to fix bugs 🙂");
    expect(fr.errorReports.description).toBe("Les rapports sont anonymes et nous aident beaucoup à corriger les bugs 🙂");
    expect(en.settings.privacy.errorReports.link).toBe("What's in a report?");
    for (const bundle of [fr, nl, de]) expect(bundle.errorReports.send).not.toBe(en.errorReports.send);
  });
});
