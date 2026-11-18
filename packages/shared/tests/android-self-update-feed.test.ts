// REL-UPD-06: the Android self-update reads our signed F-Droid repository: `entry.json` names the index with its hash,
// and the index gives the newest APK with its hash, size and signing certificates.
import { describe, expect, it } from "vitest";
import { indexFromEntry, newestApkFromIndex } from "../src/androidRepo";

const signer = "19C4BE454FDFA4A4EE1E9DAC053B1C2E269F788B95301BA3C91A1A479662F8C4";
const version = (versionName: string, versionCode: number, extra: { sha256?: string; size?: number; signers?: string[] } = {}) => ({
  file: { name: `/badger-android-${versionName}-${versionCode}-foss.apk`, sha256: extra.sha256 ?? "AB".repeat(32), size: extra.size ?? 202_491_996 },
  manifest: { versionName, versionCode, signer: { sha256: extra.signers ?? [signer] } },
});
const index = (versions: Record<string, unknown>) => ({ packages: { "com.spacebadger.mobile": { metadata: {}, versions } } });

describe("the self-update feed (REL-UPD-06)", () => {
  // @req REL-UPD-06
  it("the newest APK is the highest version code, with lowercase hashes", () => {
    expect(newestApkFromIndex(index({ a: version("0.1.3", 15767), b: version("0.1.10", 16000), c: version("0.1.4", 15800) }), "badger")).toEqual({
      versionName: "0.1.10",
      versionCode: 16000,
      apkName: "badger-android-0.1.10-16000-foss.apk",
      sha256: "ab".repeat(32),
      size: 202_491_996,
      signers: [signer.toLowerCase()],
    });
  });

  // @req REL-UPD-06
  it("a version without a hash, a size or a signer, or outside the repository folder, is skipped", () => {
    const bad = [
      version("0.2.0", 17000, { sha256: "nothex" }),
      version("0.2.1", 17001, { size: 0 }),
      version("0.2.2", 17002, { signers: [] }),
      { ...version("0.2.3", 17003), file: { ...version("0.2.3", 17003).file, name: "/sub/x.apk" } },
      { ...version("0.2.4", 17004), file: { ...version("0.2.4", 17004).file, name: "/../x.apk" } },
    ];
    const versions = Object.fromEntries(bad.map((item, i) => [`bad${i}`, item]));
    expect(newestApkFromIndex(index({ ...versions, ok: version("0.1.3", 15767) }), "badger")?.versionCode).toBe(15767);
    expect(newestApkFromIndex(index(versions), "badger")).toBeNull();
    expect(newestApkFromIndex(index({ ok: version("0.1.3", 15767) }), "parrot")).toBeNull();
    expect(newestApkFromIndex("not an index", "badger")).toBeNull();
  });

  // @req REL-UPD-06
  it("entry.json names the index file under the repository, with its hash and size", () => {
    const entry = { timestamp: 1, version: 20002, index: { name: "/index-v2.json", sha256: "F2".repeat(32), size: 21397, numPackages: 2 }, diffs: {} };
    expect(indexFromEntry(JSON.stringify(entry))).toEqual({
      url: "https://packages.spacefleet.io/fdroid/repo/index-v2.json",
      sha256: "f2".repeat(32),
      size: 21397,
    });
    expect(indexFromEntry(JSON.stringify({ ...entry, index: { ...entry.index, name: "/../x.json" } }))).toBeNull();
    expect(indexFromEntry(JSON.stringify({ ...entry, index: { ...entry.index, sha256: "x" } }))).toBeNull();
    expect(indexFromEntry("{")).toBeNull();
  });
});
