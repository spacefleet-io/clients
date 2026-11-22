/**
 * PLAT-DESK-01: Parrot desktop ships the same four Linux packages as Badger (AppImage, .deb, .rpm, .pacman), from the
 * same shared format list and package options (packages/desktop-platform-linux/packaging/linux-packages.mjs, REL-FAM-02).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig } from "../electron-builder.config.mjs";
import { LINUX_FORMATS, PACKAGE_TARGETS, linuxArtifactPatterns, resolveLinuxFormats } from "../scripts/package-targets.mjs";

const log = (line: string, data?: unknown) =>
  console.info(`[parrot-linux-packages] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// @req PLAT-DESK-01[parrot] AppImage, .deb, .rpm and .pacman by default, each named Parrot-<version>-<arch>
// @req REL-DIST-14[parrot] package "spaceparrot", taking over "parrot" < 1 only
describe("Parrot Linux packages (PLAT-DESK-01)", () => {
  it("builds all four formats by default, with the package name spaceparrot", () => {
    const config = createBuilderConfig({ targetId: "linux-x64" }) as unknown as Record<string, Record<string, unknown>>;
    log("linux", config.linux);
    expect(LINUX_FORMATS).toEqual(["AppImage", "deb", "rpm", "pacman"]);
    expect(config.linux.target).toEqual(["AppImage", "deb", "rpm", "pacman"]);
    for (const format of ["deb", "rpm", "pacman"]) {
      expect(config[format], format).toMatchObject({ packageName: "spaceparrot", artifactName: "${productName}-${version}-${arch}.${ext}" });
    }
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
    const relations = { deb: config.deb.fpm, rpm: config.rpm.fpm, pacman: config.pacman.fpm };
    log("legacy relations", relations);
    // REL-UPD-07: every native package also carries its root update helper and polkit action, last in fpm
    const updateFiles = [
      expect.stringMatching(/\/spaceparrot-system-update=\/usr\/lib\/spaceparrot\/system-update$/),
      expect.stringMatching(/\/io\.spacefleet\.spaceparrot\.update\.policy=\/usr\/share\/polkit-1\/actions\/io\.spacefleet\.spaceparrot\.update\.policy$/),
    ];
    expect(relations).toEqual({
      deb: ["--conflicts", "parrot (<< 1)", "--replaces", "parrot (<< 1)", ...updateFiles],
      rpm: [
        "--replaces", "parrot < 1", "--provides", `parrot = ${version}`, "--rpm-posttrans", expect.stringMatching(/rpm-posttrans\.sh$/),
        // no /usr/lib/.build-id links: Badger ships the same Electron binaries, rpm would refuse both together
        "--rpm-rpmbuild-define", "_build_id_links none",
        ...updateFiles,
      ],
      pacman: ["--conflicts", "parrot<1", "--replaces", "parrot<1", "--provides", `parrot=${version}`, ...updateFiles],
    });
    expect(resolveLinuxFormats("AppImage,pacman")).toEqual(["AppImage", "pacman"]);
    expect(() => resolveLinuxFormats("snap")).toThrow(/unknown Linux package format/);
  });

  // @req REL-UPD-01[parrot] plus the updater feed electron-builder writes beside them
  it("expects one Parrot file per format, and latest-linux.yml", () => {
    const built = ["Parrot-1.0.0-x86_64.AppImage", "Parrot-1.0.0-amd64.deb", "Parrot-1.0.0-x86_64.rpm", "Parrot-1.0.0-x64.pacman", "latest-linux.yml"];
    for (const patterns of [PACKAGE_TARGETS["linux-x64"].artifactPatterns, linuxArtifactPatterns(LINUX_FORMATS)]) {
      const matched = patterns.map((pattern) => built.filter((name) => pattern.test(name)));
      log("patterns -> files", matched);
      expect(matched).toEqual(built.map((name) => [name]));
    }
  });
});
