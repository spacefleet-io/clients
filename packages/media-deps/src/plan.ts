import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_LIST_VERSION,
  FFMPEG_EXTERNAL_LIBS,
  HARDWARE_FILTERS,
  MOBILE_FEATURES,
  MPV_FEATURES,
  ffmpegComponentFlags,
} from "./features";
import { forkCloneUrl, type ForgeAuth } from "./forks/git";
import { SOURCES, type SourceSpec } from "./sources";
import type { DepsTarget } from "./target";

export const getPackageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Flags shared by every OS: reduced, GPL (x264/x265), shared libs so ffmpeg, ffprobe and mpv use ONE copy. */
const FFMPEG_BASE_FLAGS = [
  "--disable-autodetect",
  "--disable-debug",
  "--disable-doc",
  "--disable-ffplay",
  "--disable-everything",
  "--enable-gpl",
  "--enable-zlib",
] as const;

/** `--enable-encoder/filter/hwaccel` flags of the hardware families + hwaccels one target drives (mobile: decode only). */
export const hardwareFlags = (target: DepsTarget): string[] => {
  const flags: string[] = [];
  for (const family of target.kind === "desktop" ? target.hardwareEncoders : []) {
    flags.push(`--enable-encoder=h264_${family}`, `--enable-encoder=hevc_${family}`);
    for (const filter of HARDWARE_FILTERS[family]) flags.push(`--enable-filter=${filter}`);
  }
  for (const hwaccel of target.ffmpegHwaccels) flags.push(`--enable-hwaccel=${hwaccel}`);
  return flags;
};

/** The complete, ordered ffmpeg `./configure` flag list of one target (the desktop list, or the shared mobile one). */
export const ffmpegConfigureFlags = (target: DepsTarget): string[] =>
  target.kind === "mobile"
    ? [
        ...MOBILE_FEATURES.ffmpegBaseFlags,
        ...MOBILE_FEATURES.ffmpegExternalLibs.map((lib) => `--enable-${lib}`),
        ...ffmpegComponentFlags(MOBILE_FEATURES.ffmpegComponents),
        ...hardwareFlags(target),
        ...target.ffmpegFlags,
      ]
    : [
        ...FFMPEG_BASE_FLAGS,
        ...FFMPEG_EXTERNAL_LIBS.map((lib) => `--enable-${lib}`),
        ...ffmpegComponentFlags(),
        ...hardwareFlags(target),
        ...target.ffmpegFlags,
      ];

export const mpvMesonOptions = (target: DepsTarget): string[] => [
  ...(target.kind === "mobile" ? MOBILE_FEATURES.mpvMesonCommon : MPV_FEATURES.mesonCommon),
  ...target.mpvMesonOptions,
];

/**
 * The pinned sources of one target: shared ones from `SOURCES` plus its own `extraSources`. A mobile target gets
 * each source's `mobileLicense` as its `license`, so its bundle and source manifests name what it actually ships.
 */
export const targetSources = (target: DepsTarget): Record<string, SourceSpec> =>
  Object.fromEntries(
    Object.entries({ ...Object.fromEntries(target.sources.map((id): [string, SourceSpec] => [id, SOURCES[id]])), ...target.extraSources }).map(([id, spec]) => [
      id,
      target.kind === "mobile" && spec.mobileLicense ? { ...spec, license: spec.mobileLicense } : spec,
    ])
  );

export const sourceBuildArgs = (target: DepsTarget): Record<string, string> => {
  const args: Record<string, string> = {};
  for (const [id, spec] of Object.entries(targetSources(target))) {
    const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    args[`SRC_${key}_URL`] = forkCloneUrl(spec.repo);
    args[`SRC_${key}_SHA`] = spec.sha;
  }
  return args;
};

/** Every docker `--build-arg` of one target (keys sorted: the recipe hash covers them). */
export const dockerBuildArgs = (target: DepsTarget): Record<string, string> => {
  const args: Record<string, string> = {
    ...sourceBuildArgs(target),
    FFMPEG_FLAGS: ffmpegConfigureFlags(target).join(" "),
    LIBPLACEBO_MESON_OPTIONS: target.libplaceboMesonOptions.join(" "),
    ...(target.kind === "desktop" && target.hostLibraries ? { HOST_LIBRARIES: target.hostLibraries.join(" ") } : {}),
    MPV_MESON_OPTIONS: mpvMesonOptions(target).join(" "),
    ...(target.buildArgs ?? {}),
  };
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
};

const listFiles = (entry: string): string[] =>
  statSync(entry).isDirectory()
    ? readdirSync(entry)
        .sort()
        .flatMap((name) => listFiles(path.join(entry, name)))
    : [entry];

/**
 * Hash of everything that determines a target's output: the resolved build args (feature list,
 * target flags, pinned commits) and the bytes of the recipe directory, the shared recipe scripts and
 * the target's `recipeInputs`. `target.ts` itself is excluded (its content is already in the args), so
 * reformatting it never rebuilds. The fork urls (`SRC_*_URL`) are excluded too: the pinned commit id already fixes
 * the source, so moving the forks to another host never changes a version. Verify/publish/fetch code is NOT part
 * of it: changing those never rebuilds binaries.
 */
export const computeRecipeHash = (target: DepsTarget, packageRoot = getPackageRoot()): string => {
  const hash = createHash("sha256");
  const args = Object.fromEntries(Object.entries(dockerBuildArgs(target)).filter(([key]) => !/^SRC_.+_URL$/.test(key)));
  hash.update(JSON.stringify({ id: target.id, args }));
  const recipeDirs = [
    path.join(packageRoot, "recipes", "_shared"),
    path.join(packageRoot, "recipes", target.id),
    ...(target.recipeInputs ?? []).map((input) => path.join(packageRoot, input)),
  ];
  for (const dir of recipeDirs) {
    for (const file of listFiles(dir)) {
      if (path.basename(file) === "target.ts") continue;
      hash.update(`\n--- ${path.relative(packageRoot, file).split(path.sep).join("/")}\n`);
      // Binary inputs (an icon) hash as bytes; text with LF endings, so a Windows checkout with core.autocrlf
      // still resolves the version CI published.
      const bytes = readFileSync(file);
      hash.update(bytes.includes(0) ? bytes : bytes.toString("utf8").replaceAll("\r\n", "\n"));
    }
  }
  return hash.digest("hex");
};

/** Where the bundles are published: one GitHub release per target and version, in this repository. */
export const RELEASES_REPO = "spacefleet-io/media-deps";
export const DEFAULT_RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases/download`;

/** The download base: MEDIA_DEPS_BASE_URL (a mirror laid out as `<base>/<tag>/<file>`) or the GitHub releases. */
export const releasesBaseUrl = (env: Record<string, string | undefined> = process.env) =>
  (env.MEDIA_DEPS_BASE_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, "");

export const packageName = (target: Pick<DepsTarget, "id">) => `media-deps-${target.id}`;
export const packageVersion = (recipeHash: string) => `fl${FEATURE_LIST_VERSION}-${recipeHash.slice(0, 12)}`;
export const archiveFileName = (target: Pick<DepsTarget, "id">) => `${packageName(target)}.tar.gz`;
/** The release (git tag) holding one target's bundle, its source archive and their `.sha256` sidecars. */
export const releaseTag = (target: Pick<DepsTarget, "id">, version: string) => `${packageName(target)}-${version}`;
export const packageFileUrl = (target: Pick<DepsTarget, "id">, version: string, file: string, baseUrl = releasesBaseUrl()) =>
  `${baseUrl}/${releaseTag(target, version)}/${file}`;

export type BuildPlan = {
  command: string;
  args: string[];
  /** Extra environment (native recipes receive the resolved build args this way). */
  env: Record<string, string>;
};

/**
 * How one target is built into `outputDir/bin`. Docker targets: `docker buildx build` exporting the
 * recipe's `out` stage (flat bin/). Native targets: `bash recipes/<id>/build.sh <outputDir>` on a runner
 * of that OS, with every resolved build arg (SRC_*_URL, FFMPEG_FLAGS, MPV_MESON_OPTIONS, …) in the
 * environment. Both must leave a flat `bin/` in `outputDir`.
 */
export const createBuildPlan = (
  target: DepsTarget,
  options: { outputDir: string; packageRoot?: string; dockerBinary?: string; forgeAuth?: ForgeAuth }
): BuildPlan => {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const buildArgs = dockerBuildArgs(target);
  // The forks are public; a credential (to read them while private, or a mirror) travels as an environment
  // variable (native recipes) / BuildKit secret (docker): never a build arg, so it is in no image layer, no
  // `docker history`, and not in the recipe hash.
  const forgeAuth: Record<string, string> = options.forgeAuth ? { FORGE_AUTH: `${options.forgeAuth.user}:${options.forgeAuth.token}` } : {};
  if (target.builder === "native") {
    return {
      command: "bash",
      args: [path.join(packageRoot, "recipes", target.id, "build.sh"), options.outputDir],
      env: { ...buildArgs, ...forgeAuth },
    };
  }
  return {
    command: options.dockerBinary ?? "docker",
    env: { DOCKER_BUILDKIT: "1", ...forgeAuth },
    args: [
      "buildx",
      "build",
      "--platform",
      target.dockerPlatform ?? "linux/amd64",
      "--target",
      "out",
      "--progress=plain",
      ...(options.forgeAuth ? ["--secret", "id=forge_auth,env=FORGE_AUTH"] : []),
      "--output",
      `type=local,dest=${options.outputDir}`,
      "-f",
      path.join(packageRoot, "recipes", target.id, "Dockerfile"),
      ...Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
      packageRoot,
    ],
  };
};
