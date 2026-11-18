import { describe, expect, it } from "vitest";
import { forkEntries } from "../src/forks/catalog";
import { compareParts, findNewTags, newTagFor, newTagsKey, stableVersion, tagNames, tagScheme } from "../src/forks/newTags";

/** A pin as the catalog gives it; only id/repo/version/upstreamRef matter to tag detection. */
const pin = (id: string, upstreamRef: string, repo = id, version = upstreamRef.replace(/^\D+/, "")) =>
  ({ id, spec: { repo, version, upstreamRef } }) as Parameters<typeof newTagFor>[0];

const newest = (upstreamRef: string, tags: string[]) => {
  const hit = newTagFor(pin("x", upstreamRef), tags);
  console.info(`[newTags.test] ${upstreamRef} among [${tags.join(" ")}] -> ${hit ? `${hit.tag} (${hit.newer.join(" ")})` : "none"}`);
  return hit;
};

describe("the fork sync's stable-tag detection @req REL-DEPS-12[ci]", () => {
  it("reads the tag scheme of every real pin kind", () => {
    expect(tagScheme("n8.1.3")).toEqual({ prefix: "n", separator: ".", parts: [8, 1, 3] });
    expect(tagScheme("v0.41.0")).toEqual({ prefix: "v", separator: ".", parts: [0, 41, 0] });
    expect(tagScheme("VER-2-13-3")).toEqual({ prefix: "VER-", separator: "-", parts: [2, 13, 3] });
    expect(tagScheme("R_2_7_5")).toEqual({ prefix: "R_", separator: "_", parts: [2, 7, 5] });
    expect(tagScheme("libdrm-2.4.124")).toEqual({ prefix: "libdrm-", separator: ".", parts: [2, 4, 124] });
    expect(tagScheme("vulkan-sdk-1.4.357.0")).toEqual({ prefix: "vulkan-sdk-", separator: ".", parts: [1, 4, 357, 0] });
    expect(tagScheme("release-3.0.5")).toEqual({ prefix: "release-", separator: ".", parts: [3, 0, 5] });
    expect(tagScheme("4.1")).toEqual({ prefix: "", separator: ".", parts: [4, 1] });
    expect(tagScheme("v2026.4")).toEqual({ prefix: "v", separator: ".", parts: [2026, 4] });
  });

  it("has no scheme for a commit pin, a ref without a trailing number or mixed separators", () => {
    expect(tagScheme("b35605ace3ddf7c1a5d67a2eb553f034aef41d55")).toBeNull();
    expect(tagScheme("634daf2")).toBeNull();
    expect(tagScheme("master")).toBeNull();
    expect(tagScheme("1.2-3")).toBeNull();
  });

  it("finds the newest stable tag above each real pin, across every scheme", () => {
    expect(newest("n8.1.3", ["n8.1.2", "n8.1.3", "n8.1.4", "n9.0", "n9.0.1"])?.tag).toBe("n9.0.1");
    expect(newest("v0.41.0", ["v0.40.0", "v0.41.0", "v0.42.0"])?.tag).toBe("v0.42.0");
    expect(newest("VER-2-13-3", ["VER-2-13-2", "VER-2-14-0", "VER-2-13-10"])?.newVersion).toBe("2.14.0");
    expect(newest("R_2_7_5", ["R_2_7_4", "R_2_8_0", "R_2_10_0", "R_2_9_9"])?.tag).toBe("R_2_10_0");
    expect(newest("libdrm-2.4.124", ["libdrm-2.4.125", "libdrm-2.4.99", "libdrm-2.5.0"])?.tag).toBe("libdrm-2.5.0");
    expect(newest("vulkan-sdk-1.4.357.0", ["vulkan-sdk-1.4.363.0", "v1.4.364", "sdk-1.4.999.0"])?.tag).toBe("vulkan-sdk-1.4.363.0");
    expect(newest("release-3.0.5", ["release-3.0.6", "release-3.0"])?.tag).toBe("release-3.0.6");
    expect(newest("4.1", ["4.0", "4.1", "4.2", "Release_3.5"])?.tag).toBe("4.2");
    expect(newest("1.5.1", ["1.5.0", "1.5.4", "1.5.10"])?.tag).toBe("1.5.10");
    expect(newest("v2026.4", ["v2026.3", "v2026.5", "v2027.0"])?.tag).toBe("v2027.0");
  });

  it("orders numerically, not as text, and treats a missing part as 0", () => {
    expect(compareParts([3, 100], [3, 99, 5])).toBeGreaterThan(0);
    expect(compareParts([8, 2], [8, 2, 0])).toBe(0);
    expect(compareParts([8, 10], [8, 9, 9])).toBeGreaterThan(0);
    // `n9.0` and `n9.0.0` are one release, listed once
    expect(newest("n8.1.3", ["n9.0", "n9.0.0"])?.newer).toEqual(["n9.0"]);
  });

  it("is quiet when the pin is current", () => {
    expect(newest("v1.4.2", ["v1.4.0", "v1.4.1", "v1.4.2"])).toBeNull();
    expect(newest("v1.4.2", [])).toBeNull();
  });

  it("does not take another product's or an older era's tags for a newer release", () => {
    // libvpl's oneVPL-era year tags predate its v2.x releases (seen on the real upstream, 2026-11-05)
    expect(newest("v2.15.0", ["v2.16.0", "v2023.4.0", "v2022.0.0"])?.tag).toBe("v2.16.0");
    // and a year-numbered pin never jumps to a plain version
    expect(newest("v2026.4", ["v3.0", "v2026.5"])?.tag).toBe("v2026.5");
    // zlib's four-number development snapshots between releases
    expect(newest("v1.3.1", ["v1.3.1.2", "v1.3.2"])?.newer).toEqual(["v1.3.2"]);
    expect(newest("v1.3.1", ["v1.3.1.2"])).toBeNull();
    // a bare date tag on a dotted scheme
    expect(newest("1.5.1", ["20240101", "1.5.2"])?.newer).toEqual(["1.5.2"]);
  });

  it("parses `git ls-remote --tags`, dropping peeled lines and our own sf/ tags", () => {
    const sha = "a".repeat(40);
    const out = [
      `${sha}\trefs/tags/n8.1.3`,
      `${sha}\trefs/tags/n8.1.3^{}`,
      `${sha}\trefs/tags/sf/8.1.3`,
      `${sha}\trefs/heads/master`,
      `${sha}\trefs/tags/n9.0`,
    ].join("\n");
    expect(tagNames(out)).toEqual(["n8.1.3", "n9.0"]);
  });
});

describe("prereleases are never picked up @req REL-UPG-08[ci]", () => {
  it("ignores release candidates, betas, alphas and development tags in every scheme", () => {
    expect(stableVersion("v0.42.0-rc1", tagScheme("v0.41.0")!)).toBeNull();
    expect(stableVersion("v0.42.0rc1", tagScheme("v0.41.0")!)).toBeNull();
    expect(stableVersion("n8.2-dev", tagScheme("n8.1.3")!)).toBeNull();
    expect(stableVersion("2.5.0b1", tagScheme("1.5.1")!)).toBeNull();
    expect(stableVersion("VER-2-14-0-RC1", tagScheme("VER-2-13-3")!)).toBeNull();
    expect(stableVersion("R_2_8_0_beta", tagScheme("R_2_7_5")!)).toBeNull();
    expect(stableVersion("v1.5.0-alpha.1", tagScheme("v1.4.36")!)).toBeNull();
    expect(stableVersion("libdrm-2.4.125-pre", tagScheme("libdrm-2.4.124")!)).toBeNull();
    const hit = newest("v0.41.0", ["v0.42.0-rc1", "v0.42.0-rc2", "v0.41.1-beta", "v0.42.0rc3"]);
    expect(hit).toBeNull();
    expect(newest("v0.41.0", ["v0.42.0-rc1", "v0.42.0"])?.newer).toEqual(["v0.42.0"]);
  });

  it("requires the same separator: `1.5.1` is not followed by `1-6-0`", () => {
    expect(stableVersion("1-6-0", tagScheme("1.5.1")!)).toBeNull();
  });
});

describe("one verdict for every pin @req REL-DEPS-12[ci]", () => {
  const entries = [
    pin("ffmpeg", "n8.1.3", "ffmpeg", "8.1.3"),
    pin("ffmpegmobile", "n8.1.3", "ffmpeg", "8.1.3-mobile"),
    pin("mpv", "v0.41.0", "mpv", "0.41.0"),
    pin("x264", "b35605ace3ddf7c1a5d67a2eb553f034aef41d55", "x264"),
    pin("zlib", "v1.3.1", "zlib"),
  ];

  it("reports new tags (desktop and mobile pins of one repository alike), skips commit pins and never calls an unlisted repository current", () => {
    const result = findNewTags(
      entries,
      new Map([
        ["ffmpeg", ["n8.1.3", "n9.0", "n9.0.1-rc1"]],
        ["x264", []],
      ])
    );
    console.info(`[newTags.test] ${JSON.stringify(result)}`);
    expect(result.found.map((hit) => `${hit.id}:${hit.version}->${hit.tag}`)).toEqual(["ffmpeg:8.1.3->n9.0", "ffmpegmobile:8.1.3-mobile->n9.0"]);
    expect(result.checked).toEqual(["ffmpeg", "ffmpegmobile"]);
    expect(result.skipped).toEqual(["x264"]);
    expect(result.missing).toEqual(["mpv", "zlib"]);
  });

  it("names each set of new tags by one key, one entry per repository, sorted", () => {
    const { found } = findNewTags(
      entries,
      new Map([
        ["ffmpeg", ["n9.0"]],
        ["mpv", ["v0.42.0"]],
        ["zlib", ["v1.3.2"]],
      ])
    );
    expect(newTagsKey(found)).toBe("ffmpeg@n9.0,mpv@v0.42.0,zlib@v1.3.2");
    expect(newTagsKey([])).toBe("");
  });

  it("gives every tag-pinned source of the real catalog a scheme, and only commit pins none", () => {
    const all = forkEntries();
    const schemeless = all.filter((entry) => !tagScheme(entry.spec.upstreamRef));
    console.info(`[newTags.test] commit pins: ${schemeless.map((entry) => entry.id).join(" ")}`);
    for (const entry of schemeless) expect(entry.spec.upstreamRef).toMatch(/^[0-9a-f]{7,40}$/);
    // the sources Chris named, desktop and phone/TV, are all watched
    for (const id of ["ffmpeg", "ffmpegmobile", "mpv", "mpvmobile"]) expect(schemeless.map((entry) => entry.id)).not.toContain(id);
    // a pin is never "newer" than itself
    for (const entry of all) expect(newTagFor(entry, [entry.spec.upstreamRef])).toBeNull();
  });
});
