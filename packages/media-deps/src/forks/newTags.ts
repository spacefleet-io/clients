import type { ForkEntry } from "./catalog";
import { parseLsRemote } from "./mirror";

/**
 * Finds the new upstream STABLE releases of the pinned media sources (REL-DEPS-12): the nightly fork sync runs it
 * after mirroring, and starts the lib-bump agent only when it finds one. Pure functions; the CLI is `forks.ts new-tags`.
 *
 * Every pin names its upstream tag (`upstreamRef`). That tag gives the source's tag scheme: a prefix, then numbers
 * joined by one separator (`n8.1.3`, `v0.41.0`, `VER-2-13-3`, `R_2_7_5`, `libdrm-2.4.124`, `vulkan-sdk-1.4.357.0`).
 * A newer release is a tag of the same scheme with a higher number. Only plain numbers count, so a release candidate,
 * beta or development tag (`v0.42.0-rc1`, `n8.2-dev`, `2.5.0b1`) never matches the scheme (REL-UPG-08), and neither
 * do another product's tags in the same repository (`vulkan-sdk-*` next to `v*`). A pin on a commit (x264, luajit,
 * the libplacebo submodules) has no tag scheme and is left to its parent's bump.
 */

export type TagScheme = { prefix: string; separator: string; parts: number[] };

const SCHEME = /^(.*?)(\d+(?:([._-])\d+)*)$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/** The tag scheme of one upstream ref, or null for a commit pin or a ref that ends in no number. */
export const tagScheme = (ref: string): TagScheme | null => {
  if (COMMIT.test(ref)) return null;
  const match = SCHEME.exec(ref);
  if (!match) return null;
  const [, prefix = "", numbers = "", separator = "."] = match;
  // a prefix that itself ends in a digit would split `abc1.2` ambiguously; none of our pins has one
  if (/\d$/.test(prefix)) return null;
  // one separator throughout (`1.2-3` is no scheme)
  if (!numbers.split(separator).every((part) => /^\d+$/.test(part))) return null;
  return { prefix, separator, parts: numbers.split(separator).map(Number) };
};

/** A leading number this large is a year (`v2026.4`), not a major version. */
const YEAR = 1000;

/**
 * The tag's numbers when it is a stable release in `scheme` (same prefix and separator, numbers only), else null.
 * - A scheme of two or more numbers wants two or more: a bare `20240101` tag is a date, not release 20240101.
 * - No more numbers than the pin has, or 3 when it has fewer: a fourth number on a three-number scheme is a
 *   development snapshot (zlib's `v1.3.1.2` between `v1.3.1` and `v1.3.2`).
 * - A year-numbered tag never follows a version-numbered pin, nor the other way round: libvpl's old `v2023.4.0` tags
 *   predate its `v2.15.0` and are not newer.
 */
export const stableVersion = (tag: string, scheme: TagScheme): number[] | null => {
  if (!tag.startsWith(scheme.prefix)) return null;
  const rest = tag.slice(scheme.prefix.length);
  const sep = scheme.separator.replace(/[.]/g, "\\.");
  const min = scheme.parts.length >= 2 ? 1 : 0;
  const max = Math.max(scheme.parts.length, 3) - 1;
  if (!new RegExp(`^\\d+(?:${sep}\\d+){${min},${max}}$`).test(rest)) return null;
  const parts = rest.split(scheme.separator).map(Number);
  if (((parts[0] ?? 0) >= YEAR) !== ((scheme.parts[0] ?? 0) >= YEAR)) return null;
  return parts;
};

/** Numeric comparison, a missing part counting as 0 (`8.2` == `8.2.0` < `8.10`). */
export const compareParts = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

export type NewTag = {
  /** The pin's id in SOURCES (`ffmpeg`, `mpvmobile`, …). */
  id: string;
  /** Fork repository name. */
  repo: string;
  /** What is pinned today. */
  version: string;
  upstreamRef: string;
  /** The newest stable tag upstream publishes in the pin's scheme. */
  tag: string;
  /** That tag's numbers joined by dots (`VER-2-14-0` -> `2.14.0`). */
  newVersion: string;
  /** Every newer stable tag, oldest first (the newest is `tag`). */
  newer: string[];
};

/** The newest stable tag of `tags` above the pin's own, or null when the pin is current or has no scheme. */
export const newTagFor = (entry: Pick<ForkEntry, "id" | "spec">, tags: readonly string[]): NewTag | null => {
  const scheme = tagScheme(entry.spec.upstreamRef);
  if (!scheme) return null;
  const newer = tags
    .map((tag) => ({ tag, parts: stableVersion(tag, scheme) }))
    .filter((t): t is { tag: string; parts: number[] } => t.parts !== null && compareParts(t.parts, scheme.parts) > 0)
    .sort((a, b) => compareParts(a.parts, b.parts) || a.tag.localeCompare(b.tag));
  // `n8.2` and `n8.2.0` are the same release: keep the first spelling of each
  const unique = newer.filter((t, i) => i === 0 || compareParts(t.parts, newer[i - 1]!.parts) !== 0);
  const newest = unique[unique.length - 1];
  if (!newest) return null;
  return {
    id: entry.id,
    repo: entry.spec.repo,
    version: entry.spec.version,
    upstreamRef: entry.spec.upstreamRef,
    tag: newest.tag,
    newVersion: newest.parts.join("."),
    newer: unique.map((t) => t.tag),
  };
};

/** The tag names of `git ls-remote --tags` output (peeled `^{}` lines and our own `sf/` tags left out). */
export const tagNames = (lsRemote: string): string[] =>
  parseLsRemote(lsRemote)
    .map((ref) => ref.name)
    .filter((name) => name.startsWith("refs/tags/") && !name.endsWith("^{}") && !name.startsWith("refs/tags/sf/"))
    .map((name) => name.slice("refs/tags/".length));

/**
 * The new stable tags of every pin, given each fork repository's tag list. A repository whose tags could not be
 * listed is in `missing`, never silently "up to date".
 */
export const findNewTags = (
  entries: readonly Pick<ForkEntry, "id" | "spec">[],
  tagsByRepo: ReadonlyMap<string, readonly string[]>
): { found: NewTag[]; checked: string[]; skipped: string[]; missing: string[] } => {
  const found: NewTag[] = [];
  const checked: string[] = [];
  const skipped: string[] = [];
  const missing = new Set<string>();
  for (const entry of entries) {
    if (!tagScheme(entry.spec.upstreamRef)) {
      skipped.push(entry.id);
      continue;
    }
    const tags = tagsByRepo.get(entry.spec.repo);
    if (!tags) {
      missing.add(entry.spec.repo);
      continue;
    }
    checked.push(entry.id);
    const hit = newTagFor(entry, tags);
    if (hit) found.push(hit);
  }
  return { found, checked, skipped, missing: [...missing] };
};

/**
 * One stable key for a set of new tags (`ffmpeg@n8.1.4,mpv@v0.42.0`): lib-bump names its branch and its
 * needs-decision issue after it, and the fork sync does not start lib-bump again for a key Chris is deciding.
 */
export const newTagsKey = (found: readonly NewTag[]): string =>
  [...new Set(found.map((t) => `${t.repo}@${t.tag}`))].sort().join(",");
