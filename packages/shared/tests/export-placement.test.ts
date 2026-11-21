import { mkdtempSync, promises as fs, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeExportFile } from "../src/exportPlacement";

// OFFL-FILE-02 (#618) + OFFL-SAFE-01: an exported file is moved into the user's folder under a name nobody else holds,
// compared without letter case, and never overwrites a file, even when two exports finish at the same moment.

let root: string;
const logs: string[] = [];
const log = (line: string) => {
  logs.push(line);
  console.info(line);
};

const staged = (name: string, body: string): string => {
  const dir = join(root, ".staging");
  writeFileSync(join(dir, name), body);
  return join(dir, name);
};

const dumpDir = (label: string) => {
  console.error(`=== [export-placement:${label}] dest=${JSON.stringify(readdirSync(join(root, "dest")).sort())}`);
  console.error(`logs:\n${logs.join("\n")}`);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sf-export-placement-"));
  await fs.mkdir(join(root, ".staging"));
  await fs.mkdir(join(root, "dest"));
  logs.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("placeExportFile", () => {
  it("moves the finished file into place under its name and leaves no staging copy", async () => {
    const src = staged("output.mkv", "movie");
    const finalPath = await placeExportFile({ sourcePath: src, destDir: join(root, "dest"), desiredName: "Lattice (1999).mkv", log });
    console.info(`[export-placement:simple] finalPath=${finalPath}`);
    expect(finalPath).toBe(join(root, "dest", "Lattice (1999).mkv"));
    expect(readFileSync(finalPath, "utf8")).toBe("movie");
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  it("a name taken in another letter case gets a suffix, the other file is untouched (#618)", async () => {
    writeFileSync(join(root, "dest", "lattice (1999).MKV"), "theirs");
    const src = staged("output.mkv", "mine");
    const finalPath = await placeExportFile({ sourcePath: src, destDir: join(root, "dest"), desiredName: "Lattice (1999).mkv", log });
    const names = readdirSync(join(root, "dest")).sort();
    console.info(`[export-placement:case] finalPath=${finalPath} names=${JSON.stringify(names)}`);
    try {
      expect(finalPath).toBe(join(root, "dest", "Lattice (1999) (2).mkv"));
      expect(readFileSync(join(root, "dest", "lattice (1999).MKV"), "utf8")).toBe("theirs");
      expect(readFileSync(finalPath, "utf8")).toBe("mine");
    } catch (err) {
      dumpDir("case");
      throw err;
    }
  });

  it("two exports finishing together with the same name (and one in another case) get three distinct names", async () => {
    const a = staged("a.mkv", "a");
    const b = staged("b.mkv", "b");
    const c = staged("c.mkv", "c");
    const dest = join(root, "dest");
    const results = await Promise.all([
      placeExportFile({ sourcePath: a, destDir: dest, desiredName: "Lattice (1999).mkv", log }),
      placeExportFile({ sourcePath: b, destDir: dest, desiredName: "Lattice (1999).mkv", log }),
      placeExportFile({ sourcePath: c, destDir: dest, desiredName: "LATTICE (1999).mkv", log }),
    ]);
    const names = readdirSync(dest).sort();
    console.info(`[export-placement:concurrent] results=${JSON.stringify(results)} names=${JSON.stringify(names)}`);
    try {
      expect(new Set(results.map((p) => p.toLowerCase())).size).toBe(3);
      expect(names).toHaveLength(3);
      expect(results.map((p) => readFileSync(p, "utf8")).sort()).toEqual(["a", "b", "c"]);
    } catch (err) {
      dumpDir("concurrent");
      throw err;
    }
  });

  it("a name another process takes between the listing and the move is never overwritten: it retries", async () => {
    const dest = join(root, "dest");
    const src = staged("output.mkv", "mine");
    let listings = 0;
    const finalPath = await placeExportFile({
      sourcePath: src,
      destDir: dest,
      desiredName: "Lattice (1999).mkv",
      log,
      // First listing is stale: another process writes the same name right after it.
      readdir: async (dir) => {
        listings += 1;
        const names = await fs.readdir(dir);
        if (listings === 1) writeFileSync(join(dest, "Lattice (1999).mkv"), "other process");
        return names;
      },
    });
    console.info(`[export-placement:race] listings=${listings} finalPath=${finalPath}`);
    try {
      expect(listings).toBe(2);
      expect(readFileSync(join(dest, "Lattice (1999).mkv"), "utf8")).toBe("other process");
      expect(finalPath).toBe(join(dest, "Lattice (1999) (2).mkv"));
      expect(readFileSync(finalPath, "utf8")).toBe("mine");
    } catch (err) {
      dumpDir("race");
      throw err;
    }
  });

  it("on a disk without hard links (FAT/exFAT USB drives) it claims the name exclusively, then renames over its own claim", async () => {
    const dest = join(root, "dest");
    writeFileSync(join(dest, "Lattice (1999).mkv"), "theirs");
    const src = staged("output.mkv", "mine");
    const finalPath = await placeExportFile({
      sourcePath: src,
      destDir: dest,
      desiredName: "Lattice (1999).mkv",
      log,
      link: async () => {
        throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
      },
    });
    console.info(`[export-placement:no-link] finalPath=${finalPath} logs=${JSON.stringify(logs)}`);
    expect(finalPath).toBe(join(dest, "Lattice (1999) (2).mkv"));
    expect(readFileSync(finalPath, "utf8")).toBe("mine");
    expect(readFileSync(join(dest, "Lattice (1999).mkv"), "utf8")).toBe("theirs");
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });
});
