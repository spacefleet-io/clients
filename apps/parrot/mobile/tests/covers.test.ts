/**
 * @test-id PARROT-MOBILE-COVERS-001
 * @level unit
 * @req PAR-META-04[parrot]
 * @why PAR-META-04 / PAR-COPY-01: the phone shows an album's cover (the picture built into the music files) from the
 *   user's own sealed copy, downloaded and opened once, then kept as a file in the app's cache. Each tile asks for its
 *   own cover; a few downloads run at once whatever the number of tiles asking, and a kept cover is answered at once
 *   (no fade). An album without a cover, or one whose cover cannot be had, keeps the drawn tile (null), and that
 *   failure is tried again later. The download, the key and the file system are replaced; the rules are the real code.
 */
import { describe, expect, it } from "vitest";
import { PARROT_COVER_DOWNLOADS } from "@space/parrot-core";
import { createPhoneCovers, phoneCoverFace, phoneCoverFileName } from "../src/lib/covers";

const log = (message: string, data?: unknown) => console.info(`[PARROT-MOBILE-COVERS-001] ${message}`, data === undefined ? "" : JSON.stringify(data));

const setup = (failing = new Set<string>(), maxBytes?: number) => {
  const written = new Map<string, Uint8Array>();
  const downloads: string[] = [];
  const fileOps: string[] = [];
  // Set to a path to make the next write of that path stop half-way (the app killed mid-write).
  const crash = { during: null as string | null };
  let running = 0;
  let mostAtOnce = 0;
  const events: Array<[string, Record<string, unknown>]> = [];
  // When each file was last shown: a counter, so "more recent" needs no clock.
  const usedAt = new Map<string, number>();
  let clock = 0;
  const covers = createPhoneCovers({
    dir: "/cache/parrot-covers",
    maxBytes,
    files: {
      exists: async (path) => written.has(path),
      mkdir: async () => undefined,
      writeBytes: async (path, bytes) => {
        fileOps.push(`write ${path}`);
        if (crash.during && path.startsWith(crash.during)) {
          written.set(path, bytes.slice(0, 2));
          throw new Error("killed mid-write");
        }
        written.set(path, bytes);
        usedAt.set(path, (clock += 1));
      },
      move: async (from, to) => {
        fileOps.push(`move ${from} -> ${to}`);
        written.set(to, written.get(from)!);
        usedAt.set(to, usedAt.get(from)!);
        written.delete(from);
      },
      remove: async (path) => {
        fileOps.push(`remove ${path}`);
        written.delete(path);
      },
      removeDir: async (dir) => {
        for (const path of [...written.keys()]) if (path.startsWith(`${dir}/`)) written.delete(path);
      },
      list: async (dir) =>
        [...written.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => ({ name: path.slice(dir.length + 1), size: written.get(path)!.byteLength, usedAt: usedAt.get(path)! })),
      touch: async (path) => {
        fileOps.push(`touch ${path}`);
        if (written.has(path)) usedAt.set(path, (clock += 1));
      },
    },
    download: async (objectKey) => {
      downloads.push(objectKey);
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      // Let the other workers start their downloads before this one ends (no clock involved).
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      running -= 1;
      if (failing.has(objectKey)) throw new Error(`404 ${objectKey}`);
      return new TextEncoder().encode(`sealed:${objectKey}`);
    },
    open: async (sealed) => new TextEncoder().encode(new TextDecoder().decode(sealed).replace("sealed:", "picture:")),
    log: (event, payload) => events.push([event, payload]),
  });
  return { covers, written, downloads, events, fileOps, crash, mostAtOnce: () => mostAtOnce, failing };
};

describe("phone album covers", () => {
  it("shows the cover over the drawing unless that cover failed to load", () => {
    const uri = "file:///cache/parrot-covers/assets_one.img";
    const faces = {
      cover: phoneCoverFace(uri, null),
      broken: phoneCoverFace(uri, uri),
      otherBroken: phoneCoverFace(uri, "file:///cache/parrot-covers/old.img"),
      none: phoneCoverFace(null, null),
      unset: phoneCoverFace(undefined, null),
    };
    log("faces", faces);
    expect(faces).toEqual({ cover: uri, broken: null, otherBroken: uri, none: null, unset: null });
  });

  it("names the kept file after the cover's random key", () => {
    expect(phoneCoverFileName("assets/0b6c1f3e-1111-4222-8333-944455556666")).toBe("assets_0b6c1f3e-1111-4222-8333-944455556666.img");
    expect(phoneCoverFileName("../x")).toBe(".._x.img");
  });

  it("downloads and opens a cover once, keeps the opened picture and answers its file address", async () => {
    const { covers, written, downloads, events } = setup();
    const [first, same] = await Promise.all([covers.uriFor("assets/one"), covers.uriFor("assets/one")]);
    log("uri", { first, written: [...written.keys()], events });
    expect(first).toBe("file:///cache/parrot-covers/assets_one.img");
    expect(same).toBe(first);
    expect(new TextDecoder().decode(written.get("/cache/parrot-covers/assets_one.img"))).toBe("picture:assets/one");
    expect(await covers.uriFor("assets/one")).toBe(first);
    expect(downloads).toEqual(["assets/one"]);
    expect(await covers.uriFor(null)).toBeNull();
  });

  it("answers every tile asking at once, a few downloads at a time, and null where there is none or it fails", async () => {
    const { covers, downloads, mostAtOnce, failing, events } = setup(new Set(["assets/broken"]));
    const keys = ["assets/broken", null, ...Array.from({ length: 9 }, (_, i) => `assets/${i + 3}`), "assets/3"];
    // Every tile on screen asks for its own picture in the same moment, as the grid's tiles do when they mount.
    const uris = await Promise.all(keys.map((key) => covers.uriFor(key)));
    log("uris", uris);
    log("events", events);
    log("downloads", { downloads, mostAtOnce: mostAtOnce() });
    expect(uris[0]).toBeNull();
    expect(uris[1]).toBeNull();
    expect(uris[2]).toBe("file:///cache/parrot-covers/assets_3.img");
    expect(uris.at(-1)).toBe(uris[2]);
    expect(uris.filter(Boolean)).toHaveLength(10);
    // One download per cover even when two tiles ask for the same one, never more than the limit at once.
    expect(downloads.filter((key) => key === "assets/3")).toHaveLength(1);
    expect(mostAtOnce()).toBe(PARROT_COVER_DOWNLOADS);
    expect(events.some(([event, payload]) => event === "parrot.cover.failed" && payload.objectKey === "assets/broken")).toBe(true);

    // The failed cover is tried again on the next look.
    failing.clear();
    expect(await covers.uriFor("assets/broken")).toBe("file:///cache/parrot-covers/assets_broken.img");
    expect(downloads.filter((key) => key === "assets/broken")).toHaveLength(2);
  });

  it("answers a kept cover at once, without a download, so a tile shows it without fading in", async () => {
    const { covers, downloads } = setup(new Set(["assets/broken"]));
    expect(covers.kept("assets/one")).toBeNull();
    const pending = covers.uriFor("assets/one");
    expect(covers.kept("assets/one")).toBeNull();
    const uri = await pending;
    await covers.uriFor("assets/broken");
    log("kept", { uri, kept: covers.kept("assets/one"), broken: covers.kept("assets/broken"), downloads });
    expect(covers.kept("assets/one")).toBe(uri);
    expect(covers.kept("assets/broken")).toBeNull();
    expect(covers.kept(null)).toBeNull();
    expect(await covers.uriFor("assets/one")).toBe(uri);
    expect(downloads.filter((key) => key === "assets/one")).toHaveLength(1);
  });

  it("forgets every kept cover on sign-out", async () => {
    const { covers, written, downloads } = setup();
    await covers.uriFor("assets/one");
    await covers.clear();
    expect(written.size).toBe(0);
    await covers.uriFor("assets/one");
    expect(downloads).toEqual(["assets/one", "assets/one"]);
  });

  // @bugfix @regression-proof: a Low Orbit cover was sometimes blank on a phone. A cover written straight to its final
  // name and cut short (the app killed, the disk full) stayed as a broken file that `exists` then answered for good.
  it("writes a cover under a temporary name and gives it its real name only once whole", async () => {
    const { covers, written, downloads, fileOps, crash } = setup();
    const final = "/cache/parrot-covers/assets_lo.img";
    crash.during = final;
    expect(await covers.uriFor("assets/lo")).toBeNull();
    log("after a cut-short write", { fileOps, files: [...written.keys()] });
    // The half-written picture never carries the name that is shown.
    expect(written.has(final)).toBe(false);

    crash.during = null;
    fileOps.length = 0;
    const uri = await covers.uriFor("assets/lo");
    log("next look", { uri, fileOps, downloads });
    expect(uri).toBe(`file://${final}`);
    expect(new TextDecoder().decode(written.get(final))).toBe("picture:assets/lo");
    expect(fileOps).toEqual([`write ${final}.part`, `move ${final}.part -> ${final}`]);
    expect(downloads).toEqual(["assets/lo", "assets/lo"]);
  });

  // @bugfix @regression-proof: a kept cover whose picture will not load is deleted and fetched once more, instead of
  // the tile staying on the drawing (or blank) for as long as the app runs.
  it("deletes a kept cover that fails to show and fetches it once more", async () => {
    const { covers, written, downloads, fileOps, events } = setup();
    const final = "/cache/parrot-covers/assets_lo.img";
    const uri = await covers.uriFor("assets/lo");
    written.set(final, new Uint8Array());
    fileOps.length = 0;

    const again = await covers.refetch("assets/lo");
    log("refetch", { again, fileOps, downloads, events: events.map(([event]) => event) });
    expect(again).toBe(uri);
    expect(fileOps[0]).toBe(`remove ${final}`);
    expect(new TextDecoder().decode(written.get(final))).toBe("picture:assets/lo");
    expect(downloads).toEqual(["assets/lo", "assets/lo"]);
    expect(covers.kept("assets/lo")).toBe(uri);
    expect(events.some(([event]) => event === "parrot.cover.refetch")).toBe(true);
    expect(await covers.refetch(null)).toBeNull();
  });

  /**
   * @test-id PARROT-MOBILE-COVERS-KEEP-001
   * @level unit
   * @req PAR-COPY-01[parrot]
   * @why Chris 2026-11-16: the phone's local copy of the vault's pictures is bounded by bytes and kept across restarts.
   *   Before this the covers folder grew with every album ever shown.
   */
  it("keeps at most maxBytes of covers, dropping the least recently shown first and fetching it again from storage", async () => {
    const k = (phase: string, data: unknown) => console.info(`[PARROT-MOBILE-COVERS-KEEP-001] phase=${phase}`, JSON.stringify(data));
    // Each opened picture is "picture:assets/x": 16 bytes, so two fit and a third does not.
    const { covers, written, downloads, events } = setup(new Set(), 40);
    await covers.uriFor("assets/a");
    await covers.uriFor("assets/b");
    // "a" is shown once more, so "b" is now the least recently shown.
    await covers.uriFor("assets/a");
    await covers.uriFor("assets/c");
    const files = [...written.keys()].sort();
    k("act", { files, events: events.map(([event]) => event) });
    expect(files).toEqual(["/cache/parrot-covers/assets_a.img", "/cache/parrot-covers/assets_c.img"]);
    // The dropped cover is forgotten, so the next look fetches it from the user's storage again.
    expect(covers.kept("assets/b")).toBeNull();
    expect(covers.kept("assets/a")).not.toBeNull();
    expect(await covers.uriFor("assets/b")).toBe("file:///cache/parrot-covers/assets_b.img");
    k("assert", { downloads });
    expect(downloads).toEqual(["assets/a", "assets/b", "assets/c", "assets/b"]);
    expect(events.some(([event]) => event === "parrot.cover.dropped")).toBe(true);
  });
});
