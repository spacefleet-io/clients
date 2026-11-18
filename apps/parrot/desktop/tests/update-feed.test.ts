/**
 * REL-UPD-01 / REL-MAC-03 / REL-INST-03: every Parrot package carries what its OS updater needs. The generic feed
 * (https://api.spacefleet.io/desktop/parrot) is baked into app-update.yml, the Mac build adds the Squirrel.Mac zip,
 * each target's artifact list names its feed file, and a release Windows build is signed for the publisher check.
 */
import { describe, expect, it } from "vitest";

import { createBuilderConfig, DEFAULT_UPDATE_FEED_URL } from "../electron-builder.config.mjs";
import { linuxArtifactPatterns, PACKAGE_TARGETS } from "../scripts/package-targets.mjs";
import { SIGNED_WINDOWS_ENV } from "../../../badger/desktop/tests/_helpers/signedWindowsEnv";

const log = (line: string, data?: unknown) =>
  console.info(`[parrot-update-feed] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const TARGETS = ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"] as const;
const matches = (patterns: RegExp[], name: string) => patterns.some((pattern) => pattern.test(name));

// @req REL-UPD-01 (Parrot's generic update feed)
describe("Parrot update feed", () => {
  it("bakes the /desktop/parrot generic feed into every target", () => {
    for (const targetId of TARGETS) {
      const config = createBuilderConfig({ targetId, env: SIGNED_WINDOWS_ENV });
      log(`${targetId} publish`, config.publish);
      expect(config.publish).toEqual([{ provider: "generic", url: "https://api.spacefleet.io/desktop/parrot", channel: "latest" }]);
    }
    expect(DEFAULT_UPDATE_FEED_URL).toBe("https://api.spacefleet.io/desktop/parrot");
  });

  it("takes another feed (staging) without a trailing slash", () => {
    const config = createBuilderConfig({ targetId: "linux-x64", updateFeedUrl: "https://api.staging.spacefleet.io/desktop/parrot/" });
    log("override publish", config.publish);
    expect(config.publish).toEqual([{ provider: "generic", url: "https://api.staging.spacefleet.io/desktop/parrot", channel: "latest" }]);
  });
});

// @req REL-UPD-01[parrot] (Parrot ships the Squirrel.Mac zip and latest-mac.yml, so its Mac updater has a payload)
describe("Parrot macOS update zip", () => {
  it("builds a dmg and an arch-named zip per arch", () => {
    for (const targetId of ["macos-arm64", "macos-x64"] as const) {
      const { arch } = PACKAGE_TARGETS[targetId];
      const { mac, dmg } = createBuilderConfig({ targetId });
      log(`${targetId} mac`, { target: mac.target, artifactName: mac.artifactName, dmg: dmg.artifactName });
      expect(mac.target).toEqual([
        { target: "dmg", arch: [arch] },
        { target: "zip", arch: [arch] },
      ]);
      expect(mac.artifactName).toBe("${productName}-${version}-${arch}-mac.${ext}");
      expect(dmg.artifactName).toBe("Parrot-${version}-${arch}.${ext}");
    }
  });
});

// @req REL-UPD-01[parrot] (each target's artifacts include its update feed file)
describe("Parrot package artifacts", () => {
  const cases: Record<(typeof TARGETS)[number], { expected: string[]; foreign: string[] }> = {
    "linux-x64": {
      expected: ["Parrot-0.1.0-x86_64.AppImage", "latest-linux.yml"],
      foreign: ["latest.yml", "latest-mac.yml"],
    },
    "windows-x64": {
      expected: ["Parrot-Setup-0.1.0.exe", "Parrot-Setup-0.1.0.exe.blockmap", "latest.yml"],
      foreign: ["latest-linux.yml", "latest-mac.yml"],
    },
    "macos-arm64": {
      expected: ["Parrot-0.1.0-arm64.dmg", "Parrot-0.1.0-arm64-mac.zip", "Parrot-0.1.0-arm64-mac.zip.blockmap", "latest-mac.yml"],
      foreign: ["Parrot-0.1.0-x64-mac.zip", "latest.yml", "latest-linux.yml"],
    },
    "macos-x64": {
      expected: ["Parrot-0.1.0-x64.dmg", "Parrot-0.1.0-x64-mac.zip", "Parrot-0.1.0-x64-mac.zip.blockmap", "latest-mac.yml"],
      foreign: ["Parrot-0.1.0-arm64-mac.zip", "latest.yml", "latest-linux.yml"],
    },
  };

  it("names the feed (and the zip on macOS) among each target's artifacts, and nothing of another OS", () => {
    for (const targetId of TARGETS) {
      const patterns = PACKAGE_TARGETS[targetId].artifactPatterns;
      const { expected, foreign } = cases[targetId];
      log(`${targetId} patterns`, patterns.map(String));
      for (const name of expected) expect(matches(patterns, name), `${targetId} ${name}`).toBe(true);
      for (const name of foreign) expect(matches(patterns, name), `${targetId} ${name}`).toBe(false);
    }
  });

  it("keeps latest-linux.yml when only some Linux formats are built", () => {
    const patterns = linuxArtifactPatterns(["AppImage"]);
    log("AppImage-only patterns", patterns.map(String));
    expect(matches(patterns, "latest-linux.yml")).toBe(true);
    expect(matches(patterns, "Parrot-0.1.0-x86_64.AppImage")).toBe(true);
  });
});

// @req REL-INST-03 (Parrot's updater checks the Windows publisher, so release builds are signed)
describe("Parrot Windows publisher check", () => {
  it("verifies update signatures against the certificate's publisher", () => {
    const { win } = createBuilderConfig({ targetId: "windows-x64", env: SIGNED_WINDOWS_ENV });
    log("signed win", { verifyUpdateCodeSignature: win.verifyUpdateCodeSignature, publisherName: win.azureSignOptions?.publisherName });
    expect(win.verifyUpdateCodeSignature).toBe(true);
    expect(win.azureSignOptions?.publisherName).toBe("PENA Chris-Alexandre");
  });

  it("refuses an unsigned Windows build, but leaves Linux and macOS alone", () => {
    expect(() => createBuilderConfig({ targetId: "windows-x64", env: {} })).toThrow(/updater requires updates signed by "PENA Chris-Alexandre"/);
    for (const targetId of ["linux-x64", "macos-arm64"] as const) {
      expect(createBuilderConfig({ targetId, env: {} }).win.verifyUpdateCodeSignature).toBe(false);
    }
  });
});
