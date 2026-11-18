/**
 * @test-id MOBILE-APPLE-TV-NATIVE-MODULES-001
 * @level unit
 * @bugfix @regression-proof
 *
 * Why exists: PLAT-TV-01 — the Apple TV app links the same native modules as the phone, minus the ones
 * react-native.config.js keeps out of the tvOS target (SB_APPLE_TV=1). React Native's autolinking silently drops a
 * pod whose podspec declares no tvOS platform, and the JS that needs it then dies at launch. On 2026-11-13 the
 * physical Apple TV opened on a red box, "TurboModuleRegistry.getEnforcing(...): 'QuickBase64' could not be found":
 * react-native-quick-crypto needs react-native-quick-base64, whose 3.0.1 podspec is iOS-only. So every native
 * dependency the TV keeps must declare tvOS in its podspec.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mobile = resolve(__dirname, "..");
const requireFromMobile = createRequire(join(mobile, "package.json"));

type RnConfig = { dependencies: Record<string, { root?: string; platforms?: { ios?: unknown } }> };

/** react-native.config.js as the TV target's autolinking sees it (ios/Podfile runs it with SB_APPLE_TV=1). */
function tvConfig(): RnConfig {
  const path = join(mobile, "react-native.config.js");
  const before = process.env.SB_APPLE_TV;
  process.env.SB_APPLE_TV = "1";
  try {
    delete requireFromMobile.cache[requireFromMobile.resolve(path)];
    return requireFromMobile(path) as RnConfig;
  } finally {
    if (before === undefined) delete process.env.SB_APPLE_TV;
    else process.env.SB_APPLE_TV = before;
    delete requireFromMobile.cache[requireFromMobile.resolve(path)];
  }
}

function packageRoot(name: string, config: RnConfig): string {
  const root = config.dependencies[name]?.root;
  if (root) return root;
  try {
    return dirname(requireFromMobile.resolve(`${name}/package.json`));
  } catch {
    return join(mobile, "node_modules", name);
  }
}

/**
 * A podspec restricts its platforms with a literal `s.platform = :ios`, a literal `s.platforms = { ... }` hash or
 * per-platform deployment targets; then tvOS must be named. No such line builds for every platform, and
 * `s.platforms = min_supported_versions` is React Native's own helper, which lists tvOS in react-native-tvos.
 */
function podspecSupportsTvos(podspec: string): boolean {
  const restricts = /^\s*s\.platform\s*=\s*:|^\s*s\.platforms\s*=\s*\{|^\s*s\.\w+\.deployment_target\s*=/m.test(podspec);
  return !restricts || /:tvos\b|\btvos\s*:|\.tvos\.deployment_target\b/.test(podspec);
}

describe("the Apple TV target links every native module its JS needs", () => {
  it("a podspec without a platform line, or naming tvOS, counts as tvOS", () => {
    expect(podspecSupportsTvos(`Pod::Spec.new do |s|\n  s.name = "a"\nend`)).toBe(true);
    expect(podspecSupportsTvos(`  s.platforms    = { :ios => "13.0", :tvos => "13.0" }`)).toBe(true);
    expect(podspecSupportsTvos(`  s.platforms       = { ios: '15.1', tvos: '15.1' }`)).toBe(true);
    expect(podspecSupportsTvos(`  s.ios.deployment_target = 12.4\n  s.tvos.deployment_target = 13.4`)).toBe(true);
    expect(podspecSupportsTvos(`  s.platforms              = min_supported_versions`)).toBe(true);
    expect(podspecSupportsTvos(`  s.platforms    = { :ios => min_ios_version_supported }`)).toBe(false);
    expect(podspecSupportsTvos(`  s.platform = :ios, "12.0"`)).toBe(false);
    expect(podspecSupportsTvos(`  s.ios.deployment_target = 12.4`)).toBe(false);
  });

  it("every podspec dependency the TV keeps declares tvOS", () => {
    const pkg = JSON.parse(readFileSync(join(mobile, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const config = tvConfig();
    const checked: string[] = [];
    const missing: string[] = [];
    for (const name of Object.keys(pkg.dependencies)) {
      if (config.dependencies[name]?.platforms?.ios === null) continue;
      const root = packageRoot(name, config);
      let podspecs: string[];
      try {
        podspecs = readdirSync(root).filter((f) => f.endsWith(".podspec"));
      } catch {
        continue;
      }
      for (const file of podspecs) {
        checked.push(`${name}/${file}`);
        if (!podspecSupportsTvos(readFileSync(join(root, file), "utf8"))) missing.push(`${name}/${file}`);
      }
    }
    console.info("[apple-tv-native-modules] podspecs checked:", checked.join(", "));
    expect(checked).toContain("react-native-quick-base64/react-native-quick-base64.podspec");
    expect(missing).toEqual([]);
  });
});
