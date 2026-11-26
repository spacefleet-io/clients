import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig, DEFAULT_UPDATE_FEED_URL } from "../electron-builder.config.mjs";
import {
  findMissingResources,
  PACKAGE_TARGETS,
  requiredResourcesFor,
  resolvePackageTarget,
  runtimeBinaryName,
  runtimeCompileArgs,
  stageDirFor,
  unpackedResourcesDir,
} from "../scripts/package-targets.mjs";
import { LINUX_FORMATS, LINUX_TOOL_PACKAGES, missingLinuxPackageTools } from "@space/desktop-platform-linux/packaging/linux-packages";
import { SIGNED_WINDOWS_ENV } from "@space/desktop-platform-windows/packaging/signedWindowsEnv";

type Builder = {
  appId: string;
  productName: string;
  win?: { target: unknown; executableName?: string; verifyUpdateCodeSignature?: boolean };
  nsis?: Record<string, unknown>;
  linux?: { target: unknown };
  mac?: Record<string, unknown>;
  dmg?: Record<string, unknown>;
  afterPack?: { hookPath: string };
  publish: Array<{ provider: string; url: string; channel: string }> | null;
  extraResources: Array<{ from: string; to: string }>;
};
// A release Windows config is refused unsigned (REL-INST-03): every config here gets fake Artifact Signing secrets.
const config = (targetId: string, updateFeedUrl?: string) =>
  createBuilderConfig({ targetId, updateFeedUrl, env: SIGNED_WINDOWS_ENV }) as unknown as Builder;

describe("package targets", () => {
  it("knows linux-x64, windows-x64 and both macOS arches and rejects anything else loudly", () => {
    expect(Object.keys(PACKAGE_TARGETS).sort()).toEqual(["linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
    expect(resolvePackageTarget().id).toBe("linux-x64");
    expect(() => resolvePackageTarget("macos-universal")).toThrow(/unknown package target "macos-universal"/);
  });

  // @req PLAT-DESK-05 two macOS downloads, one per arch, never universal
  it("builds macOS per arch: darwin runtime, its own deps bundle, its own unpacked dir", () => {
    for (const arch of ["arm64", "x64"] as const) {
      const target = PACKAGE_TARGETS[`macos-${arch}`];
      console.info(`[package-targets:mac] ${JSON.stringify({ ...target, artifactPatterns: target.artifactPatterns.map(String) })}`);
      expect(target).toMatchObject({
        productName: "Badger",
        builderFlag: "--mac",
        arch,
        bunTarget: `bun-darwin-${arch}`,
        nodePlatform: "darwin",
        exeSuffix: "",
        depsDir: `vendor/deps/macos-${arch}`,
        inAppUpdates: true,
      });
      expect(runtimeCompileArgs(target, "/out/runtime")).toContain(`--target=bun-darwin-${arch}`);
      expect(runtimeCompileArgs(target, "/out/runtime")).not.toContain("--windows-hide-console");
    }
    expect(unpackedResourcesDir("/dist", PACKAGE_TARGETS["macos-arm64"])).toBe(
      join("/dist", "mac-arm64", "Badger.app", "Contents", "Resources"),
    );
    expect(unpackedResourcesDir("/dist", PACKAGE_TARGETS["macos-x64"])).toBe(
      join("/dist", "mac", "Badger.app", "Contents", "Resources"),
    );
    expect(unpackedResourcesDir("/dist", PACKAGE_TARGETS["linux-x64"])).toBe(join("/dist", "linux-unpacked", "resources"));
  });

  // @req REL-MAC-03 Badger-<version>-<arch>.dmg, plus the arch's update zip, its blockmap and latest-mac.yml
  it("reports the arch's dmg, update zip (+ blockmap) and latest-mac.yml as macOS artifacts", () => {
    const arm = PACKAGE_TARGETS["macos-arm64"].artifactPatterns;
    const x64 = PACKAGE_TARGETS["macos-x64"].artifactPatterns;
    console.info(`[package-targets:mac-artifacts] arm64 ${arm.map(String).join(" ")} | x64 ${x64.map(String).join(" ")}`);
    const matches = (patterns: RegExp[], name: string) => patterns.some((pattern) => pattern.test(name));
    const each = (patterns: RegExp[], built: string[]) => patterns.map((pattern) => built.filter((name) => pattern.test(name)));
    const armBuilt = ["Badger-0.2.0-arm64.dmg", "Badger-0.2.0-arm64-mac.zip", "Badger-0.2.0-arm64-mac.zip.blockmap", "latest-mac.yml"];
    expect(each(arm, armBuilt)).toEqual(armBuilt.map((name) => [name]));
    const x64Built = ["Badger-0.2.0-x64.dmg", "Badger-0.2.0-x64-mac.zip", "Badger-0.2.0-x64-mac.zip.blockmap", "latest-mac.yml"];
    expect(each(x64, x64Built)).toEqual(x64Built.map((name) => [name]));
    for (const name of ["Badger-0.2.0-x64.dmg", "Badger-0.2.0-x64-mac.zip", "Badger-0.2.0-universal-mac.zip"]) expect(matches(arm, name), name).toBe(false);
    // No dmg blockmap: the updater never downloads the dmg.
    expect(matches(arm, "Badger-0.2.0-arm64.dmg.blockmap") || matches(x64, "Badger-0.2.0-x64.dmg.blockmap")).toBe(false);
  });

  it("names the runtime binary per target without inspecting the host", () => {
    expect(runtimeBinaryName(PACKAGE_TARGETS["linux-x64"])).toBe("runtime");
    expect(runtimeBinaryName(PACKAGE_TARGETS["windows-x64"])).toBe("runtime.exe");
    expect(runtimeBinaryName(PACKAGE_TARGETS["macos-arm64"])).toBe("runtime");
    expect(stageDirFor("/app", PACKAGE_TARGETS["windows-x64"])).toBe(join("/app", ".package-stage", "windows-x64"));
  });

  it("requires the runtime, OSC lua files and icons in every target, the update config where the updater ships", () => {
    for (const target of Object.values(PACKAGE_TARGETS)) {
      const required = requiredResourcesFor(target);
      expect(required).toContain(`runtime/${runtimeBinaryName(target)}`);
      expect(required).toContain("mpv/osc/sf.lua");
      expect(required).toContain("mpv/osc/tog4in1/tog4in1.lua");
      expect(required).toContain("mpv/icons/spacebadger.png");
      expect(required).toContain("trayTemplate.png");
      expect(required.includes("app-update.yml")).toBe(target.inAppUpdates);
    }
    // macOS: mpv is the helper app in Contents/Helpers, next to Contents/Resources.
    expect(requiredResourcesFor(PACKAGE_TARGETS["macos-arm64"])).toEqual(
      expect.arrayContaining([
        "deps/bin/ffmpeg",
        "deps/bin/ffprobe",
        "deps/bin/sf-lifeline",
        "deps/lib",
        "deps/deps-manifest.json",
        "../Helpers/Badger Player.app/Contents/MacOS/mpv",
      ]),
    );
    expect(requiredResourcesFor(PACKAGE_TARGETS["windows-x64"])).toEqual(
      expect.arrayContaining(["deps/bin/mpv.exe", "deps/bin/ffmpeg.exe", "deps/bin/ffprobe.exe", "deps/deps-manifest.json"]),
    );
  });

  it("reports exactly the resources missing from an unpacked build", () => {
    const target = PACKAGE_TARGETS["windows-x64"];
    const resources = join("/pkg", "resources");
    const present = new Set(requiredResourcesFor(target).map((relative) => join(resources, relative)));
    expect(findMissingResources(resources, target, (file: string) => present.has(file))).toEqual([]);

    present.delete(join(resources, "deps/bin/mpv.exe"));
    present.delete(join(resources, "mpv/osc/sf.lua"));
    expect(findMissingResources(resources, target, (file: string) => present.has(file))).toEqual([
      "mpv/osc/sf.lua",
      "deps/bin/mpv.exe",
    ]);
  });
});

describe("electron-builder config", () => {
  it("builds a per-user, non-elevating, one-click NSIS installer for Windows", () => {
    const win = config("windows-x64");
    expect(win.appId).toBe("io.spacefleet.badger-desktop");
    expect(win.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(win.win?.verifyUpdateCodeSignature).toBe(true);
    expect(win.nsis).toMatchObject({ oneClick: true, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false });
    expect(win.nsis?.artifactName).toMatch(/^Badger-Setup-\$\{version\}\.\$\{ext\}$/);
  });

  // @req PLAT-DESK-01[badger-desktop] AppImage, .deb, .rpm and .pacman, AppImage first (latest-linux.yml `path:`)
  // @req REL-DIST-04[badger-desktop] contact@spacefleet.io, https://spacebadger.io, Audio & Video
  // @req REL-DIST-14[badger-desktop] package "spacebadger", taking over "badger" < 1 only (never Debian's BadgerDB 2.x)
  it("builds the AppImage, .deb, .rpm and .pacman, named and described as Badger", () => {
    const linux = config("linux-x64") as unknown as Record<string, Record<string, unknown>> & { extraMetadata: { homepage: string } };
    expect(linux.linux).toMatchObject({ target: ["AppImage", "deb", "rpm", "pacman"], category: "AudioVideo", maintainer: "SpaceFleet <contact@spacefleet.io>" });
    expect(linux.extraMetadata.homepage).toBe("https://spacebadger.io");
    for (const format of ["deb", "rpm", "pacman"]) {
      expect(linux[format], format).toMatchObject({ packageName: "spacebadger", artifactName: "${productName}-${version}-${arch}.${ext}" });
      // the bundled mpv leaves GL/EGL and the text stack to the host: the package must pull them in
      expect((linux[format].depends as string[]).join(" "), format).toMatch(/fontconfig|libfontconfig/);
    }
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
    const relations = { deb: linux.deb.fpm, rpm: linux.rpm.fpm, pacman: linux.pacman.fpm };
    console.info(`[package-targets] legacy relations ${JSON.stringify(relations)}`);
    // REL-UPD-07: every native package also carries its root update helper and polkit action, last in fpm
    const updateFiles = [
      expect.stringMatching(/\/spacebadger-system-update=\/usr\/lib\/spacebadger\/system-update$/),
      expect.stringMatching(/\/io\.spacefleet\.spacebadger\.update\.policy=\/usr\/share\/polkit-1\/actions\/io\.spacefleet\.spacebadger\.update\.policy$/),
    ];
    expect(relations).toEqual({
      deb: ["--conflicts", "badger (<< 1)", "--replaces", "badger (<< 1)", ...updateFiles],
      rpm: [
        "--replaces", "badger < 1", "--provides", `badger = ${version}`, "--rpm-posttrans", expect.stringMatching(/rpm-posttrans\.sh$/),
        // no /usr/lib/.build-id links: Parrot ships the same Electron binaries, rpm would refuse both together
        "--rpm-rpmbuild-define", "_build_id_links none",
        ...updateFiles,
      ],
      pacman: ["--conflicts", "badger<1", "--replaces", "badger<1", "--provides", `badger=${version}`, ...updateFiles],
    });
    const patterns = PACKAGE_TARGETS["linux-x64"].artifactPatterns;
    const built = ["Badger-1.2.3.AppImage", "Badger-1.2.3-amd64.deb", "Badger-1.2.3-x86_64.rpm", "Badger-1.2.3-x64.pacman", "latest-linux.yml"];
    expect(patterns.map((pattern) => built.filter((name) => pattern.test(name)))).toEqual(built.map((name) => [name]));
  });

  it("names the host tools a Linux build lacks, with the Debian package that provides each", () => {
    const has = (present: string[]) => (tool: string) => present.includes(tool);
    expect(missingLinuxPackageTools(LINUX_FORMATS, has(["xz", "ar", "rpmbuild", "zstd", "bsdtar"]))).toEqual([]);
    expect(missingLinuxPackageTools(["AppImage"], has([]))).toEqual([]);
    const missing = missingLinuxPackageTools(LINUX_FORMATS, has(["xz", "ar"]));
    expect(missing).toEqual(["rpmbuild", "zstd", "bsdtar"]);
    expect(missing.map((tool) => (LINUX_TOOL_PACKAGES as Record<string, string>)[tool])).toEqual(["rpm", "zstd", "libarchive-tools"]);
  });

  // @req REL-MAC-05 Badger.app, bundle id io.spacefleet.badger-desktop
  it("names the app Badger on every OS (Badger.app on the Mac), with the Mac bundle id io.spacefleet.badger-desktop", () => {
    expect(config("macos-arm64").productName).toBe("Badger");
    expect(config("macos-x64").productName).toBe("Badger");
    expect(config("macos-arm64").appId).toBe("io.spacefleet.badger-desktop");
    expect(config("linux-x64").productName).toBe("Badger");
    expect(config("windows-x64").productName).toBe("Badger");
  });

  // @req REL-MAC-02 signed in afterPack (Developer ID + notarized app when the APPLE_* secrets are set), in-app updates
  // @req REL-MAC-03 one dmg + one update zip per arch: Badger-<version>-<arch>.dmg, Badger-<version>-<arch>-mac.zip
  // @req REL-UPD-01[badger-desktop] app-update.yml points the Mac updater at the generic feed
  // @req PLAT-DESK-02 macOS 14 minimum
  it("builds a dmg and an update zip per arch for macOS 14+, with the update feed", () => {
    for (const arch of ["arm64", "x64"]) {
      const mac = config(`macos-${arch}`);
      console.info(`[package-targets:mac-config] ${arch} ${JSON.stringify({ mac: mac.mac, dmg: mac.dmg, publish: mac.publish })}`);
      expect(mac.mac).toMatchObject({
        target: [
          { target: "dmg", arch: [arch] },
          { target: "zip", arch: [arch] },
        ],
        artifactName: "${productName}-${version}-${arch}-mac.${ext}",
        icon: "installer/icon.icns",
        category: "public.app-category.video",
        minimumSystemVersion: "14.0",
        identity: null,
        hardenedRuntime: false,
        notarize: false,
      });
      expect(mac.dmg).toMatchObject({ artifactName: "Badger-${version}-${arch}.${ext}", writeUpdateInfo: false });
      expect(mac.publish).toEqual([{ provider: "generic", url: DEFAULT_UPDATE_FEED_URL, channel: "latest" }]);
      expect(mac.afterPack?.hookPath.replaceAll("\\", "/")).toMatch(/\/scripts\/mac-after-pack\.mjs$/);
    }
  });

  it("ships the runtime, OSC lua files and icons from every target", () => {
    for (const targetId of Object.keys(PACKAGE_TARGETS)) {
      const tos = config(targetId).extraResources.map((entry) => entry.to);
      expect(tos).toEqual(
        expect.arrayContaining(["runtime", "mpv/osc", "mpv/icons", "icon.png", "trayTemplate.png", "trayTemplate@2x.png"]),
      );
    }
  });

  // @req PLAT-DESK-06 menu-bar icon is a 16/32 px monochrome template image
  it("ships a 16 px + 32 px @2x monochrome template image for the macOS menu bar", () => {
    for (const [name, size] of [["trayTemplate.png", 16], ["trayTemplate@2x.png", 32]] as const) {
      const png = readFileSync(join(__dirname, "..", "installer", name));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      // color type 6 = RGBA: a template image is all alpha
      expect(png[25]).toBe(6);
    }
    const icns = readFileSync(join(__dirname, "..", "installer", "icon.icns"));
    expect(icns.subarray(0, 4).toString()).toBe("icns");
  });

  // UX-THEME-04 (#3299): each desktop platform names its own icon and there is no top-level `icon`, or
  // electron-builder draws the Linux icons from mac.icon (the navy tile). The tray / window icon stays a square PNG.
  it("names each platform's own icon: a square >=256px tray PNG, one square PNG per hicolor size, a .ico for Windows", () => {
    const appDir = join(__dirname, "..");
    const pngSide = (path: string): number => {
      const png = readFileSync(path);
      expect(png.subarray(1, 4).toString(), path).toBe("PNG");
      const width = png.readUInt32BE(16);
      expect(png.readUInt32BE(20), path).toBe(width);
      return width;
    };
    for (const targetId of ["linux-x64", "windows-x64"]) {
      const cfg = config(targetId) as unknown as {
        icon?: string;
        linux: { icon: string };
        win: { icon: string };
        extraResources: Array<{ from: string; to: string }>;
      };
      expect(cfg.icon, targetId).toBeUndefined();

      const tray = cfg.extraResources.find((entry) => entry.to === "icon.png")?.from;
      expect(tray, targetId).toBe(join(appDir, "installer", "icon.png"));
      const traySide = pngSide(tray!);
      expect(traySide).toBeGreaterThanOrEqual(256);

      const hicolor = readdirSync(join(appDir, cfg.linux.icon)).filter((name) => name.endsWith(".png"));
      const sides = hicolor.map((name) => {
        const side = pngSide(join(appDir, cfg.linux.icon, name));
        expect(name).toBe(`${side}x${side}.png`);
        return side;
      });
      expect(Math.max(...sides)).toBeGreaterThanOrEqual(256);

      const ico = readFileSync(join(appDir, cfg.win.icon));
      expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
      const icoSides = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
      expect(icoSides).toContain(256);
      console.info(
        `[package-targets.test] ${targetId} tray=${traySide}px linux=${cfg.linux.icon} [${sides.sort((a, b) => a - b).join(",")}] win=${cfg.win.icon} [${icoSides.join(",")}]`,
      );
    }
  });

  it("ships vendor/deps/<target> as <resources>/deps on every target", () => {
    const winDeps = config("windows-x64").extraResources.find((entry) => entry.to === "deps");
    expect(winDeps?.from.replaceAll("\\", "/")).toMatch(/\/vendor\/deps\/windows-x64$/);
    const linuxDeps = config("linux-x64").extraResources.find((entry) => entry.to === "deps");
    expect(linuxDeps?.from.replaceAll("\\", "/")).toMatch(/\/vendor\/deps\/linux-x64$/);
    for (const id of ["macos-arm64", "macos-x64"]) {
      const macDeps = config(id).extraResources.find((entry) => entry.to === "deps");
      expect(macDeps?.from.replaceAll("\\", "/")).toMatch(new RegExp(`/vendor/deps/${id}$`));
    }
  });

  // @req REL-UPD-01 every target bakes the same generic feed into app-update.yml
  it("points electron-updater at the generic feed on every target, overridable at build time", () => {
    for (const targetId of Object.keys(PACKAGE_TARGETS)) {
      expect(config(targetId).publish, targetId).toEqual([{ provider: "generic", url: DEFAULT_UPDATE_FEED_URL, channel: "latest" }]);
    }
    expect(DEFAULT_UPDATE_FEED_URL).toBe("https://api.spacefleet.io/desktop/badger");
    expect(config("windows-x64", "https://feed.example.test/desktop/badger///").publish?.[0]?.url).toBe(
      "https://feed.example.test/desktop/badger",
    );
  });
});
