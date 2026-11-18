/**
 * PLAT-MOBILE-06, REL-DIST-20, REL-UPD-06: what the apps themselves know of SpaceFleet's own Android repository at
 * https://packages.spacefleet.io: its address, its signing key, each app's package, and how to read the newest APK of
 * an app from the signed index. The Android self-update (`@space/mobile-self-update`) reads the repository with it,
 * and the publishers and the API that serves the repository build on it.
 */

import { z } from "zod";

export const ANDROID_PACKAGES_HOST = "https://packages.spacefleet.io";
export const FDROID_REPO_URL = `${ANDROID_PACKAGES_HOST}/fdroid/repo`;
export const ANDROID_APPS = ["badger", "parrot"] as const;
export type AndroidApp = (typeof ANDROID_APPS)[number];

/** Android package of each app's release build (the same id on Google Play, in this repository, in both builds). */
export const ANDROID_PACKAGE_NAMES: Record<AndroidApp, string> = { badger: "com.spacebadger.mobile", parrot: "io.spacefleet.parrot" };

/**
 * SHA-256 of the repository signing certificate, uppercase hex without colons, the form the F-Droid app pins
 * (`?fingerprint=`). Checked 2026-11-16 against the certificate that signs the live `entry.jar` and `index-v1.jar`.
 */
export const ANDROID_REPO_FINGERPRINT = "CE1B8CE37FC0975EBCA7D9F7B88AF902D258D7AC185AFFDAE41CF87296BDBC14";

/** A file name in the index: `/<name>` at the repository root (an APK) or below it (an icon). */
export const RepoFileName = z.string().regex(/^\/[^.][^]*$/).refine((name) => !name.includes(".."));
/** The `packages` map of a parsed `index-v2.json`, keyed by Android package. */
export const IndexPackages = z.object({ packages: z.record(z.string(), z.unknown()) });

/** The newest APK of an app in the repository, with what the Android self-update checks before installing it (REL-UPD-06). */
export type RepoApk = {
  versionName: string;
  versionCode: number;
  /** File name under `fdroid/repo/`. */
  apkName: string;
  /** Lowercase hex SHA-256 of the APK file. */
  sha256: string;
  size: number;
  /** Lowercase hex SHA-256 of each certificate that signs the APK. */
  signers: string[];
};

const sha256Hex = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((hex) => hex.toLowerCase());
const RepoVersion = z.object({
  manifest: z.object({
    versionName: z.string().min(1),
    versionCode: z.number().int().positive(),
    signer: z.object({ sha256: z.array(sha256Hex).min(1) }),
  }),
  file: z.object({
    name: RepoFileName.refine((name) => !name.slice(1).includes("/") && name.endsWith(".apk")),
    sha256: sha256Hex,
    size: z.number().int().positive(),
  }),
});

/**
 * The newest version (highest versionCode) of the app in a parsed `index-v2.json` that carries a file hash, a size and
 * its signers; versions missing any of them are skipped. Null when the index does not list the app or no version
 * qualifies. The index must already be verified against the signed `entry.jar` (the caller's job).
 */
export const newestApkFromIndex = (index: unknown, app: AndroidApp): RepoApk | null => {
  const packages = IndexPackages.safeParse(index);
  const entry = packages.success ? z.object({ versions: z.record(z.string(), z.unknown()) }).safeParse(packages.data.packages[ANDROID_PACKAGE_NAMES[app]]) : null;
  if (!entry?.success) return null;
  let newest: RepoApk | null = null;
  for (const raw of Object.values(entry.data.versions)) {
    const version = RepoVersion.safeParse(raw);
    if (!version.success || (newest && version.data.manifest.versionCode <= newest.versionCode)) continue;
    const { manifest, file } = version.data;
    newest = {
      versionName: manifest.versionName,
      versionCode: manifest.versionCode,
      apkName: file.name.slice(1),
      sha256: file.sha256,
      size: file.size,
      signers: manifest.signer.sha256,
    };
  }
  return newest;
};

const RepoEntry = z.object({
  index: z.object({ name: RepoFileName.refine((name) => name.endsWith(".json")), sha256: sha256Hex, size: z.number().int().positive() }),
});

/** The index file the repository's signed `entry.json` names, with its hash and size; null for anything else. */
export const indexFromEntry = (entryJson: string): { url: string; sha256: string; size: number } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entryJson);
  } catch {
    return null;
  }
  const entry = RepoEntry.safeParse(parsed);
  if (!entry.success) return null;
  const { name, sha256, size } = entry.data.index;
  return { url: `${FDROID_REPO_URL}${name}`, sha256, size };
};
