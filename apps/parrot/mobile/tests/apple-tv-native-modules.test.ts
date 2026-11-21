/**
 * @test-id PARROT-APPLE-TV-NATIVE-MODULES-001
 * @level unit
 * @req PAR-TV-01[parrot-tv]
 * @why The Parrot Apple TV app (target ParrotTV) links the same native modules as the iPhone app, minus the ones
 *   react-native.config.js keeps out of the tvOS target (PARROT_APPLE_TV=1). React Native's autolinking silently drops
 *   a pod whose podspec declares no tvOS platform, and the JS that needs it then dies at launch (Badger's Apple TV hit
 *   this with react-native-quick-base64 on 2026-11-13, MOBILE-APPLE-TV-NATIVE-MODULES-001). So every native dependency
 *   the TV keeps must declare tvOS in its podspec: AudioPlayback, MediaProxy, MediaVolume and the community modules.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mobile = resolve(__dirname, "..");
const requireFromMobile = createRequire(join(mobile, "package.json"));

type RnConfig = { dependencies: Record<string, { root?: string; platforms?: { ios?: unknown } }> };

// The app declares only the variables its own code reads (src/declarations.d.ts); this one is the Podfile's.
const env: Record<string, string | undefined> = process.env;

/** react-native.config.js as autolinking sees it: the TV target's (ios/Podfile runs it with PARROT_APPLE_TV=1) or the phone's. */
function rnConfig(appleTv: boolean): RnConfig {
  const path = join(mobile, "react-native.config.js");
  const before = env.PARROT_APPLE_TV;
  if (appleTv) env.PARROT_APPLE_TV = "1";
  else delete env.PARROT_APPLE_TV;
  try {
    delete requireFromMobile.cache[requireFromMobile.resolve(path)];
    return requireFromMobile(path) as RnConfig;
  } finally {
    if (before === undefined) delete env.PARROT_APPLE_TV;
    else env.PARROT_APPLE_TV = before;
    delete requireFromMobile.cache[requireFromMobile.resolve(path)];
  }
}

const tvConfig = () => rnConfig(true);

/** The modules a config leaves out of iOS (`platforms.ios: null`). */
const iosExcluded = (config: RnConfig) =>
  Object.entries(config.dependencies)
    .filter(([, dep]) => dep.platforms?.ios === null)
    .map(([name]) => name);

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

describe("the Parrot Apple TV target links every native module its JS needs", () => {
  it("leaves out of the TV only the camera, photo picker and image resizer, beyond what the iPhone leaves out", () => {
    const phone = new Set(iosExcluded(rnConfig(false)));
    const tvOnly = iosExcluded(tvConfig())
      .filter((name) => !phone.has(name))
      .sort();
    console.info("[parrot-apple-tv-native-modules] excluded from tvOS only:", tvOnly.join(", "), "| also from iOS:", [...phone].join(", "));
    expect(tvOnly).toEqual(["@bam.tech/react-native-image-resizer", "react-native-camera-kit", "react-native-image-picker"]);
  });

  it("every podspec dependency the TV keeps declares tvOS", () => {
    const pkg = JSON.parse(readFileSync(join(mobile, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const config = tvConfig();
    const names = new Set([...Object.keys(pkg.dependencies), ...Object.keys(config.dependencies)]);
    const checked: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
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
    console.info("[parrot-apple-tv-native-modules] podspecs checked:", checked.join(", "));
    expect(checked).toContain("react-native-quick-base64/react-native-quick-base64.podspec");
    expect(checked).toContain("@space/mobile-audio-playback/AudioPlayback.podspec");
    expect(missing).toEqual([]);
  });
});
