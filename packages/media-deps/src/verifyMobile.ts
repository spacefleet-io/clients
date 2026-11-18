import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MOBILE_FEATURES } from "./features";
import type { MobileDepsTarget } from "./target";

const execFileAsync = promisify(execFile);

/**
 * Static verification of a MOBILE bundle (REL-DEPS-11). Nothing in it runs on the build host, so every check reads
 * the built libraries: their Mach-O load commands, and the strings ffmpeg and mpv compile into themselves
 * (`avutil_license()`, `avutil_configuration()`, mpv's "List of enabled features").
 */

/** `<lib> license: <licence>` as ffmpeg compiles it into every library (`avutil_license()` & co). */
export const embeddedFfmpegLicense = (binary: string, lib: string): string | undefined =>
  new RegExp(`${lib} license: ([^\\0\\n]+)`).exec(binary)?.[1];

/** ffmpeg's configure line (`avutil_configuration()`): the NUL-terminated string holding `--disable-everything`. */
export const embeddedFfmpegConfiguration = (binary: string): string | undefined =>
  /(?<=\0)[^\0]*--disable-everything[^\0]*/.exec(binary)?.[0]?.trim();

/** mpv's "List of enabled features" (FULLCONFIG), compiled into libmpv by meson. */
export const embeddedMpvFeatures = (binary: string): string[] | undefined =>
  /List of enabled features: ([^\0\n]+)/.exec(binary)?.[1]?.trim().split(/\s+/);

/** Why an ffmpeg build is not the mobile one: GPL / nonfree, an encoder, a muxer, a GPL codec library, ffmpeg programs. */
export const ffmpegConfigurationProblems = (configuration: string): string[] => {
  const flags = configuration.split(/\s+/);
  const problems: string[] = [];
  for (const flag of flags) {
    if (/^--enable-(gpl|nonfree|version3)$/.test(flag)) problems.push(`licence_flag:${flag}`);
    if (/^--enable-(encoder|muxer|outdev|indev)=/.test(flag)) problems.push(`not_playback:${flag}`);
    if (/^--enable-lib(x264|x265|mp3lame|fdk-aac|xvid|vidstab|rubberband)$/.test(flag)) problems.push(`gpl_or_encoder_library:${flag}`);
  }
  for (const required of ["--disable-everything", "--disable-programs"]) if (!flags.includes(required)) problems.push(`missing:${required}`);
  return problems;
};

/** Why an mpv feature list is not the mobile one: a required feature missing, a forbidden one (gpl, cplayer) present. */
export const mpvFeatureProblems = (features: readonly string[], required: readonly string[]): string[] => [
  ...required.filter((name) => !features.includes(name)).map((name) => `missing:${name}`),
  ...MOBILE_FEATURES.mpvForbiddenFeatures.filter((name) => features.includes(name)).map((name) => `forbidden:${name}`),
];

// LC_ALL=C: the checks parse readelf/otool's English labels ("Library soname"), which a localized host translates.
const run = async (file: string, args: string[]): Promise<string> =>
  (await execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout;

/** Where the one slice of `<Name>.xcframework` keeps its framework: Xcode names the slice like the target id. */
export const appleFrameworkPath = (bundleDir: string, target: MobileDepsTarget, name: string) =>
  path.join(bundleDir, `${name}.xcframework`, target.id, `${name}.framework`);

/** The LC_BUILD_VERSION platform an Apple target's binaries must carry, as otool names it (IOS, TVOSSIMULATOR …). */
export const applePlatformName = (target: MobileDepsTarget): string => `${target.os.toUpperCase()}${target.simulator ? "SIMULATOR" : ""}`;

/**
 * The Apple mobile bundle contract: exactly `target.libraries` as `<Name>.xcframework`, each one slice holding
 * `<Name>.framework/<Name>` (arm64 only, LC_BUILD_VERSION platform iOS / tvOS or its simulator with the target's
 * minimum OS, install name `@rpath/<Name>.framework/<Name>`, LC_RPATH `@loader_path/..` only, links nothing but the
 * set's frameworks, /usr/lib and /System, no debug symbols) and an Info.plist naming it; no symlinks. Libmpv carries
 * its C headers + module map.
 */
const appleBundleProblems = async (bundleDir: string, target: MobileDepsTarget, minimumOs: string): Promise<string[]> => {
  const problems: string[] = [];
  const shipped = readdirSync(bundleDir).filter((entry) => entry.endsWith(".xcframework")).map((entry) => entry.replace(/\.xcframework$/, ""));
  const want = [...target.libraries].sort();
  if (shipped.sort().join(",") !== want.join(",")) problems.push(`xcframeworks:${shipped.join(",")} (want ${want.join(",")})`);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() && !entry.isSymbolicLink() ? walk(full) : [full];
    });
  for (const file of walk(bundleDir)) if (lstatSync(file).isSymbolicLink()) problems.push(`symlink:${path.relative(bundleDir, file)}`);
  const platform = applePlatformName(target);
  for (const name of want) {
    const framework = appleFrameworkPath(bundleDir, target, name);
    const binary = path.join(framework, name);
    if (!existsSync(binary)) {
      problems.push(`missing:${path.relative(bundleDir, binary)}`);
      continue;
    }
    const plist = path.join(framework, "Info.plist");
    const key = async (field: string) => (await run("plutil", ["-extract", field, "raw", "-o", "-", plist]).catch(() => "")).trim();
    if ((await key("CFBundleExecutable")) !== name) problems.push(`info_plist:${name}:CFBundleExecutable=${await key("CFBundleExecutable")}`);
    if ((await key("CFBundlePackageType")) !== "FMWK") problems.push(`info_plist:${name}:CFBundlePackageType=${await key("CFBundlePackageType")}`);
    if ((await key("MinimumOSVersion")) !== minimumOs) problems.push(`info_plist:${name}:MinimumOSVersion=${await key("MinimumOSVersion")}`);
    const archs = (await run("lipo", ["-archs", binary])).trim();
    if (archs !== target.arch) problems.push(`arch:${name}:${archs} (want ${target.arch})`);
    const loadCommands = await run("otool", ["-l", binary]);
    const build = /cmd LC_BUILD_VERSION\n(?:.*\n)*?\s+platform (\S+)\n\s+minos (\S+)/.exec(loadCommands);
    // otool prints the platform by name (IOS) or number (2 = iOS, 3 = tvOS, 7 = iOS simulator, 8 = tvOS simulator).
    const builtPlatform = { "2": "IOS", "3": "TVOS", "7": "IOSSIMULATOR", "8": "TVOSSIMULATOR" }[build?.[1] ?? ""] ?? build?.[1];
    if (builtPlatform !== platform) problems.push(`platform:${name}:${build?.[1] ?? "none"} (want ${platform})`);
    if (build?.[2] !== minimumOs) problems.push(`minos:${name}:${build?.[2] ?? "none"} (want ${minimumOs})`);
    const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+) \(offset \d+\)/g)].map((match) => match[1] ?? "");
    if (rpaths.join("|") !== "@loader_path/..") problems.push(`rpaths:${name}:${rpaths.join(",") || "none"} (want @loader_path/..)`);
    const ownId = (await run("otool", ["-D", binary])).split("\n")[1]?.trim();
    if (ownId !== `@rpath/${name}.framework/${name}`) problems.push(`install_name:${name}:${ownId}`);
    const links = (await run("otool", ["-L", binary]))
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (")[0] ?? "")
      .filter((dep) => dep && dep !== ownId);
    for (const dep of links) {
      if (dep.startsWith("/usr/lib/") || dep.startsWith("/System/")) continue;
      const linked = /^@rpath\/([^/]+)\.framework\/\1$/.exec(dep)?.[1];
      if (linked && want.includes(linked)) continue;
      problems.push(`link:${name}:${dep}`);
    }
    // Every import bound to a linked library: a flat-namespace lookup (`-undefined dynamic_lookup`) links fine and
    // only fails in dyld on the device, or resolves by luck against whatever the app happens to load.
    const flat = (await run("nm", ["-m", "-u", binary])).split("\n").filter((line) => line.includes("(dynamically looked up)"));
    if (flat.length > 0) problems.push(`flat_lookup:${name}:${flat.length} (${flat.slice(0, 5).map((line) => line.trim().split(" ")[2]).join(",")})`);
    // Stripped: no debug map (N_STAB) entries left.
    // Debugging stabs only: ld64 writes one `OPT radr://5614542` marker stab into every image it links, strip keeps it.
    const stabs = (await run("nm", ["-ap", binary]))
      .split("\n")
      .filter((line) => / - [0-9a-f]{2} [0-9a-f]{4} /.test(line) && !/ OPT radr:\/\/5614542$/.test(line)).length;
    if (stabs > 0) problems.push(`not_stripped:${name}:${stabs} debug symbols`);
  }
  const mpvFramework = appleFrameworkPath(bundleDir, target, "Libmpv");
  for (const file of ["Headers/client.h", "Headers/render.h", "Modules/module.modulemap"]) {
    if (!existsSync(path.join(mpvFramework, file))) problems.push(`missing:Libmpv.framework/${file}`);
  }
  return problems;
};

/** File name of one bundle library on Android: Libavcodec -> libavcodec.so, Libc++_shared -> libc++_shared.so. */
export const androidLibraryFile = (name: string) => `${name.toLowerCase()}.so`;

/** Libraries an Android bundle may link besides its own: the NDK's stable system libraries (bionic, log, GLES/EGL, audio, media). */
export const ANDROID_SYSTEM_LIBRARIES: readonly string[] = [
  "libc.so",
  "libm.so",
  "libdl.so",
  "liblog.so",
  "libz.so",
  "libandroid.so",
  "libEGL.so",
  "libGLESv2.so",
  "libGLESv3.so",
  "libOpenSLES.so",
  "libaaudio.so",
  "libmediandk.so",
  "libnativewindow.so",
  "libjnigraphics.so",
];

const ANDROID_MACHINES: Record<MobileDepsTarget["arch"], string> = {
  arm64: "AArch64",
  arm: "ARM",
  x64: "Advanced Micro Devices X86-64",
  ia32: "Intel 80386",
};

/** 16 KiB pages exist only on 64-bit Android devices; a 32-bit system always runs 4 KiB pages. */
const ANDROID_MIN_PAGE_ALIGN: Record<MobileDepsTarget["arch"], number> = { arm64: 0x4000, x64: 0x4000, arm: 0x1000, ia32: 0x1000 };

/**
 * The Android bundle contract: exactly `target.libraries` as `lib/<ANDROID_ABI>/<name>.so` (the jniLibs tree), each
 * an ELF shared object of the target's machine, SONAME = its file name (Android loads by file name, never
 * `libfoo.so.62`), NEEDED only the set's own libraries and NDK system libraries, stripped (no .symtab, no .debug_*),
 * no text relocations (Android 6+ refuses to load them; 32-bit x86 assembly is where they come from), every LOAD
 * segment aligned to the largest page size of the ABI (16 KiB on 64-bit: devices with 16 KiB pages refuse less).
 */
const androidBundleProblems = async (bundleDir: string, target: MobileDepsTarget, abi: string): Promise<string[]> => {
  const problems: string[] = [];
  const libDir = path.join(bundleDir, "lib", abi);
  if (!existsSync(libDir)) return [`missing:lib/${abi}`];
  const want = target.libraries.map(androidLibraryFile).sort();
  const shipped = readdirSync(libDir).sort();
  if (shipped.join(",") !== want.join(",")) problems.push(`libraries:${shipped.join(",")} (want ${want.join(",")})`);
  const others = readdirSync(path.join(bundleDir, "lib")).filter((entry) => entry !== abi);
  if (others.length) problems.push(`other_abis:${others.join(",")}`);
  for (const file of want) {
    const binary = path.join(libDir, file);
    if (!existsSync(binary)) {
      problems.push(`missing:lib/${abi}/${file}`);
      continue;
    }
    if (lstatSync(binary).isSymbolicLink()) problems.push(`symlink:${file}`);
    const header = await run("readelf", ["-h", binary]);
    if (!/Type:\s+DYN/.test(header)) problems.push(`not_shared_object:${file}`);
    const machine = /Machine:\s+(.+)/.exec(header)?.[1]?.trim();
    if (machine !== ANDROID_MACHINES[target.arch]) problems.push(`machine:${file}:${machine} (want ${ANDROID_MACHINES[target.arch]})`);
    const dynamic = await run("readelf", ["-d", binary]);
    const soname = /\(SONAME\)\s+Library soname: \[(.+)\]/.exec(dynamic)?.[1];
    if (soname !== file) problems.push(`soname:${file}:${soname ?? "none"}`);
    for (const needed of [...dynamic.matchAll(/\(NEEDED\)\s+Shared library: \[(.+)\]/g)].map((match) => match[1] ?? "")) {
      if (!want.includes(needed) && !ANDROID_SYSTEM_LIBRARIES.includes(needed)) problems.push(`link:${file}:${needed}`);
    }
    if (/\(TEXTREL\)|\(FLAGS\).*TEXTREL/.test(dynamic)) problems.push(`textrel:${file}`);
    const sections = await run("readelf", ["-S", "-W", binary]);
    const debug = [...sections.matchAll(/\]\s+(\.symtab|\.debug_\S+)\s/g)].map((match) => match[1]);
    if (debug.length) problems.push(`not_stripped:${file}:${debug.join(",")}`);
    const segments = await run("readelf", ["-l", "-W", binary]);
    for (const load of segments.split("\n").filter((line) => /^\s+LOAD\s/.test(line))) {
      const align = Number.parseInt(load.trim().split(/\s+/).at(-1) ?? "0", 16);
      const minAlign = ANDROID_MIN_PAGE_ALIGN[target.arch];
      if (align < minAlign) problems.push(`page_align:${file}:0x${align.toString(16)} (want >= 0x${minAlign.toString(16)})`);
    }
  }
  return problems;
};

/** The bundle's dynamic library binaries by name (Apple: the framework binary of each xcframework's one slice). */
const libraryBinary = (bundleDir: string, target: MobileDepsTarget, name: string): string => {
  switch (target.os) {
    case "ios":
    case "tvos":
      return path.join(appleFrameworkPath(bundleDir, target, name), name);
    case "android":
      return path.join(bundleDir, "lib", target.buildArgs?.ANDROID_ABI ?? "", androidLibraryFile(name));
    default:
      throw new Error(`mobile_bundle_layout_unknown:${target.os}`);
  }
};

export type MobileVerifyOptions = {
  bundleDir: string;
  target: MobileDepsTarget;
  hostPlatform: string;
  log?: (line: string) => void;
};

export const verifyMobileTarget = async (options: MobileVerifyOptions): Promise<{ ok: boolean; failures: string[]; passed: string[] }> => {
  const { bundleDir, target } = options;
  const log = options.log ?? ((line: string) => console.info(line));
  const apple = target.os === "ios" || target.os === "tvos";
  if (apple && options.hostPlatform !== "darwin") throw new Error(`verify_needs_darwin_host:running_on_${options.hostPlatform}`);
  const failures: string[] = [];
  const passed: string[] = [];
  const check = async (name: string, body: () => Promise<string | void>) => {
    try {
      const detail = await body();
      passed.push(name);
      log(`[media-deps:verify] ok   ${name}${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      log(`[media-deps:verify] FAIL ${name}: ${message}`);
    }
  };
  const read = (name: string) => readFileSync(libraryBinary(bundleDir, target, name)).toString("latin1");

  if (apple) {
    const minimumOs = target.buildArgs?.APPLE_MIN_OS;
    await check("apple frameworks: arch, platform, minimum OS, install names, links, rpaths, stripped", async () => {
      if (!minimumOs) throw new Error("target_without_APPLE_MIN_OS");
      const problems = await appleBundleProblems(bundleDir, target, minimumOs);
      if (problems.length) throw new Error(problems.join("; "));
      return `${target.libraries.length} frameworks, ${target.os} ${minimumOs}`;
    });
  }

  if (target.os === "android") {
    const abi = target.buildArgs?.ANDROID_ABI;
    await check("android libraries: ABI, sonames, links, stripped, no text relocations, page alignment", async () => {
      if (!abi) throw new Error("target_without_ANDROID_ABI");
      const problems = await androidBundleProblems(bundleDir, target, abi);
      if (problems.length) throw new Error(problems.join("; "));
      return `${target.libraries.length} libraries, ${abi}`;
    });
  }

  await check("ffmpeg libraries are LGPL (avutil_license & co)", async () => {
    const licences: string[] = [];
    for (const name of target.libraries) {
      // Libavutil -> libavutil; mpv and MoltenVK carry no ffmpeg licence string.
      if (!/^Lib(av|sw)[a-z]+$/.test(name)) continue;
      const lib = name.toLowerCase();
      const licence = embeddedFfmpegLicense(read(name), lib);
      licences.push(`${lib}=${licence ?? "none"}`);
      if (!licence?.startsWith("LGPL")) throw new Error(`${lib}: ${licence ?? "no licence string"}`);
    }
    if (licences.length === 0) throw new Error("no ffmpeg library in the bundle");
    return licences.join(", ");
  });

  await check("ffmpeg configuration: playback only, no GPL, no encoder, no muxer", async () => {
    const configuration = embeddedFfmpegConfiguration(read("Libavutil"));
    if (!configuration) throw new Error("no configuration string in Libavutil");
    log(`[media-deps:verify] ffmpeg configuration: ${configuration}`);
    const problems = ffmpegConfigurationProblems(configuration);
    if (problems.length) throw new Error(problems.join("; "));
  });

  await check("mpv features: libmpv, LGPL (no gpl), the platform's renderer / audio / hwdec", async () => {
    const features = embeddedMpvFeatures(read("Libmpv"));
    if (!features) throw new Error("no feature list in Libmpv");
    log(`[media-deps:verify] mpv features: ${features.join(" ")}`);
    const problems = mpvFeatureProblems(features, [...MOBILE_FEATURES.mpvRequiredFeatures, ...target.mpvRequiredFeatures]);
    if (problems.length) throw new Error(problems.join("; "));
    return features.join(" ");
  });

  return { ok: failures.length === 0, failures, passed };
};
