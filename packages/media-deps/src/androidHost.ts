import { readFileSync } from "node:fs";
import path from "node:path";

/** The steps of recipes/_android, in the order the Dockerfile runs them (each in WORKDIR /work). */
export const ANDROID_STEPS = ["toolchain", "libs", "ffmpeg", "mpv", "player", "assemble"] as const;

/**
 * Moves the Docker build's absolute roots (`/opt/x`, `/work/x`, `/recipe/x` and the bare roots) under `root`.
 * Without `root` (a build at the Docker paths) the text is unchanged.
 */
export const relocateAndroidRecipe = (text: string, root?: string): string =>
  root === undefined
    ? text
    : text.replace(/(^|[\s"'=(:])\/(opt|work|recipe)(?=[/\s"']|$)/gm, (_, before: string, dir: string) => `${before}${root}/${dir}`);

/** The toolchain step's NDK download and unpack (curl, sha256 check, unzip, move, cleanup). */
const NDK_DOWNLOAD = /^(curl .*"\$NDK_URL"|echo "\$NDK_SHA256 .*|unzip -q \/tmp\/ndk\.zip .*|mv \/opt\/android-ndk-\* .*|rm \/tmp\/ndk\.zip)$/;

/**
 * The toolchain step without its NDK download: a host build brings the NDK itself (at /opt/ndk), and the step still
 * checks that NDK's version. Throws when the step no longer has exactly those 5 lines, so a recipe change is noticed.
 */
export const withoutNdkDownload = (text: string): string => {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !NDK_DOWNLOAD.test(line));
  if (lines.length - kept.length !== 5) throw new Error("recipes/_android/steps/toolchain.sh changed: update NDK_DOWNLOAD in src/androidHost.ts");
  return kept.join("\n");
};

/**
 * The recipe's scripts as a host build runs them, by path under the recipe root (`env.sh`, `steps/<step>.sh`):
 * the files of recipes/_android unchanged except for the NDK download and, with `root`, the moved roots.
 */
export const androidHostScripts = (packageRoot: string, root?: string): Record<string, string> => {
  const recipe = path.join(packageRoot, "recipes", "_android");
  const scripts: Record<string, string> = { "env.sh": relocateAndroidRecipe(readFileSync(path.join(recipe, "env.sh"), "utf8"), root) };
  for (const step of ANDROID_STEPS) {
    const text = readFileSync(path.join(recipe, "steps", `${step}.sh`), "utf8");
    scripts[`steps/${step}.sh`] = relocateAndroidRecipe(step === "toolchain" ? withoutNdkDownload(text) : text, root);
  }
  return scripts;
};
