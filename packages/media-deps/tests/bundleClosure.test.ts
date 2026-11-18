import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findUnreachableLibraries, readElfNeeded } from "../src/bundleClosure";

// @bugfix media-deps-bundles-libs-only-host-libs-need @regression-proof
// assemble.sh copied lddtree's FLAT closure, which also lists what the host libraries it skips depend on:
// fl1-d04bd0f286ea leaves libxcb to the host yet carried libXau, libXdmcp and (through libXdmcp) libbsd and libmd,
// 208 KB that nothing loads: the host's libxcb has no $ORIGIN RUNPATH and resolves them from the host.
describe("@bugfix @regression-proof a bundled library must be reachable from the binaries through bundled libraries (#25)", () => {
  // DT_NEEDED of fl1-d04bd0f286ea (abridged to the X11 branch); libxcb / libX11 are host libraries, so not in the map.
  const PUBLISHED: ReadonlyMap<string, readonly string[]> = new Map([
    ["mpv", ["libva-x11.so.2", "libXext.so.6", "libX11.so.6", "libc.so.6"]],
    ["ffmpeg", ["libavcodec.so.62", "libc.so.6"]],
    ["ffprobe", ["libavcodec.so.62", "libc.so.6"]],
    ["libavcodec.so.62", ["libva.so.2", "libc.so.6"]],
    ["libva.so.2", ["libc.so.6"]],
    ["libva-x11.so.2", ["libva.so.2", "libX11.so.6", "libxcb.so.1", "libXext.so.6"]],
    ["libXext.so.6", ["libX11.so.6", "libc.so.6"]],
    ["libXau.so.6", ["libc.so.6"]],
    ["libXdmcp.so.6", ["libbsd.so.0", "libc.so.6"]],
    ["libbsd.so.0", ["libmd.so.0", "libc.so.6"]],
    ["libmd.so.0", ["libc.so.6"]],
  ]);

  it("flags the libraries only a host library needs", () => {
    const unreachable = findUnreachableLibraries(PUBLISHED, ["mpv", "ffmpeg", "ffprobe"]);
    console.info(`[media-deps:closure] unreachable: ${unreachable.join(",")}`);
    expect(unreachable).toEqual(["libXau.so.6", "libXdmcp.so.6", "libbsd.so.0", "libmd.so.0"]);
  });

  it("a closure walked only through bundled libraries has nothing unreachable", () => {
    const pruned = new Map([...PUBLISHED].filter(([name]) => !/^lib(Xau|Xdmcp|bsd|md)\./.test(name)));
    expect(findUnreachableLibraries(pruned, ["mpv", "ffmpeg", "ffprobe"])).toEqual([]);
  });
});

describe("readElfNeeded", () => {
  it.runIf(process.platform === "linux")("reads DT_NEEDED of a dynamically linked ELF (the running bun)", () => {
    const needed = readElfNeeded(readFileSync(process.execPath));
    console.info(`[media-deps:closure] ${process.execPath} NEEDED: ${needed.join(",")}`);
    expect(needed).toContain("libc.so.6");
  });

  it("refuses a file that is not a 64-bit little-endian ELF", () => {
    expect(() => readElfNeeded(Buffer.from('{"schemaVersion":1}'))).toThrow("not_elf64le");
  });
});
