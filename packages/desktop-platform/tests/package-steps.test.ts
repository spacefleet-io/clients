/**
 * The packaging steps Badger and Parrot share (REL-FAM-03, packaging/package-steps.mjs): the symbols archive refuses a
 * build with no source maps (REL-LOG-06), the report refuses a build that dropped an expected artifact, and both apps'
 * package.mjs run through the shared steps instead of their own copies.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEVELOPER_ID_INTERMEDIATE_CERT, absentArtifacts, sha256, sourcemapArchiveFiles } from "../packaging/package-steps.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const log = (phase: string, msg: string) => console.info(`[package-steps:${phase}] ${msg}`);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake app dir whose out/ holds `files` (relative to out/). */
const appWith = (files: string[]) => {
  const appDir = mkdtempSync(join(tmpdir(), "package-steps-"));
  dirs.push(appDir);
  for (const file of files) {
    const path = join(appDir, "out", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
  }
  log("setup", `${appDir}/out: ${files.join(", ") || "(empty)"}`);
  return appDir;
};

describe("the symbols archive", () => {
  // @req REL-LOG-06[badger-desktop,parrot] REL-FAM-03
  it("@req REL-LOG-06[badger-desktop,parrot] holds the built JS and its maps, relative to the app, and nothing else", () => {
    const appDir = appWith(["main/index.js", "main/index.js.map", "preload/index.cjs", "renderer/assets/a.mjs", "renderer/index.html", "renderer/a.css"]);
    const files = sourcemapArchiveFiles(join(appDir, "out"), appDir).sort();
    log("archive", files.join(", "));
    expect(files).toEqual(["out/main/index.js", "out/main/index.js.map", "out/preload/index.cjs", "out/renderer/assets/a.mjs"]);
  });

  // @req REL-LOG-06[badger-desktop,parrot] REL-FAM-03
  it("@req REL-LOG-06[badger-desktop,parrot] refuses a build with no source maps, and an empty build", () => {
    const noMaps = appWith(["main/index.js", "renderer/assets/a.js"]);
    expect(() => sourcemapArchiveFiles(join(noMaps, "out"), noMaps)).toThrow(/holds no source maps: the build must emit them \(REL-LOG-06\)/);
    const empty = appWith(["renderer/index.html"]);
    expect(() => sourcemapArchiveFiles(join(empty, "out"), empty)).toThrow(/no built \.js or \.map files/);
    log("refuse", "no maps and no JS both refused");
  });
});

describe("the artifact report", () => {
  const linux = [/^Parrot-.+\.AppImage$/, /^Parrot-.+\.deb$/, /^latest-linux\.yml$/];
  const windows = [/-Setup-.*\.exe$/, /\.exe\.blockmap$/, /^latest\.yml$/];

  // @req REL-FAM-03
  it("@req REL-FAM-03 names every expected format the build did not produce, blockmaps included", () => {
    expect(absentArtifacts(linux, ["Parrot-1.0.0.AppImage", "Parrot-1.0.0.deb", "latest-linux.yml"])).toEqual([]);
    const missingDeb = absentArtifacts(linux, ["Parrot-1.0.0.AppImage", "latest-linux.yml"]);
    log("absent", missingDeb.map((p) => p.source).join(", "));
    expect(missingDeb).toEqual([linux[1]]);
    expect(absentArtifacts(windows, ["Badger-Setup-1.0.0.exe", "latest.yml"])).toEqual([windows[1]]);
  });

  it("hashes an artifact with sha256", async () => {
    const appDir = appWith([]);
    const file = join(appDir, "a.bin");
    writeFileSync(file, "abc");
    expect(await sha256(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("both apps package through the shared steps", () => {
  // @req REL-FAM-03
  it("@req REL-FAM-03 neither package.mjs keeps its own copy of a shared step", () => {
    expect(existsSync(DEVELOPER_ID_INTERMEDIATE_CERT)).toBe(true);
    for (const app of ["badger", "parrot"]) {
      const script = readFileSync(join(repoRoot, "apps", app, "desktop", "scripts", "package.mjs"), "utf8");
      const code = script.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
      log(app, `${code.split("\n").length} code lines`);
      expect(code).toContain("createPackageRun(");
      expect(code).toContain(`pkg.symbols({ project: "${app}-desktop" })`);
      for (const shared of ["electronBuilder(", "signatures()", "notarize()", "report("]) expect(code).toContain(`pkg.${shared}`);
      // The copies that used to live here.
      for (const gone of ["createHash", "authenticodeProblems", "notarytoolSubmitArgs", "openSigningKeychain", "DeveloperIDG2CA", "process.umask"]) {
        expect(code).not.toContain(gone);
      }
    }
  });
});
