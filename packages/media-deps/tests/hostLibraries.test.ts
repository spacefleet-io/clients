import { describe, expect, it } from "vitest";
import { findUnreachableLibraries } from "../src/bundleClosure";
import { findBundledHostLibraries } from "../src/hostLibraries";
import { loadDesktopTarget as loadTarget } from "../src/targets";

/**
 * Size plan P4 (#25): fl1-d04bd0f286ea shipped 5.76 MiB of libraries the desktop app's own Electron already needs on
 * every host it runs on (ALSA, GLib, D-Bus and GTK's text stack: fontconfig, freetype, harfbuzz, fribidi), plus what
 * only those pull in (pcre, uuid, graphite2, png16, brotli). A library may be left to the host only when Electron
 * itself NEEDS it, transitively (PLAT-DESK-04: no per-distro assumptions); anything else must stay bundled or mpv
 * fails to start on a host that lacks it.
 */
// DT_NEEDED of fl1-d04bd0f286ea, the branches the host move cuts (`readelf -d`).
const PUBLISHED: ReadonlyMap<string, readonly string[]> = new Map([
  ["mpv", ["libass.so.9", "libasound.so.2", "libpulse.so.0", "libXss.so.1", "libXpresent.so.1", "libva.so.2", "libc.so.6"]],
  ["ffmpeg", ["libavcodec.so.62", "libc.so.6"]],
  ["ffprobe", ["libavcodec.so.62", "libc.so.6"]],
  ["libavcodec.so.62", ["libva.so.2", "libc.so.6"]],
  ["libva.so.2", ["libc.so.6"]],
  ["libXss.so.1", ["libX11.so.6", "libc.so.6"]],
  ["libXpresent.so.1", ["libX11.so.6", "libc.so.6"]],
  ["libass.so.9", ["libfribidi.so.0", "libharfbuzz.so.0", "libfontconfig.so.1", "libfreetype.so.6", "libc.so.6"]],
  ["libharfbuzz.so.0", ["libglib-2.0.so.0", "libfreetype.so.6", "libgraphite2.so.3", "libc.so.6"]],
  ["libfontconfig.so.1", ["libfreetype.so.6", "libexpat.so.1", "libuuid.so.1", "libc.so.6"]],
  ["libfreetype.so.6", ["libpng16.so.16", "libz.so.1", "libbrotlidec.so.1", "libc.so.6"]],
  ["libglib-2.0.so.0", ["libpcre.so.3", "libc.so.6"]],
  ["libpulse.so.0", ["libpulsecommon-15.99.so", "libdbus-1.so.3", "libc.so.6"]],
  ["libpulsecommon-15.99.so", ["libdbus-1.so.3", "libc.so.6"]],
  ["libdbus-1.so.3", ["libc.so.6"]],
  ["libasound.so.2", ["libc.so.6"]],
  ["libfribidi.so.0", ["libc.so.6"]],
  ["libgraphite2.so.3", ["libc.so.6"]],
  ["libuuid.so.1", ["libc.so.6"]],
  ["libpng16.so.16", ["libz.so.1", "libc.so.6"]],
  ["libbrotlidec.so.1", ["libbrotlicommon.so.1", "libc.so.6"]],
  ["libbrotlicommon.so.1", ["libc.so.6"]],
  ["libpcre.so.3", ["libc.so.6"]],
]);

// Electron 44.7.0 NEEDS these (directly: asound, glib, dbus; through gtk-3 / pango / cairo: the text stack).
const ELECTRON_PROVIDED = [
  "libasound.so.2",
  "libglib-2.0.so.0",
  "libdbus-1.so.3",
  "libfontconfig.so.1",
  "libfreetype.so.6",
  "libharfbuzz.so.0",
  "libfribidi.so.0",
];
// Only reached through ELECTRON_PROVIDED: they leave with them (assemble.sh walks NEEDED through bundled libraries).
const PULLED_ONLY_BY_PROVIDED = [
  "libgraphite2.so.3",
  "libuuid.so.1",
  "libpng16.so.16",
  "libbrotlidec.so.1",
  "libbrotlicommon.so.1",
  "libpcre.so.3",
];
// Not in Electron's NEEDED closure (Chromium dlopens libpulse; libXss / libXpresent / libva / libass are mpv's own):
// a host without them would fail to start mpv, so they must never become host libraries.
const MPV_ONLY = ["libpulse.so.0", "libpulsecommon-15.99.so", "libXss.so.1", "libXpresent.so.1", "libva.so.2", "libass.so.9"];
// Sonames move between distro releases (jammy glib links libpcre.so.3, noble's links libpcre2): a library reached only
// through a host library must not be a host library itself, or a bundled consumer would bind whatever the host has.
const NOT_HOST_GLOBBED = [...PULLED_ONLY_BY_PROVIDED, ...MPV_ONLY];

describe("@bugfix @regression-proof linux-x64 leaves to the host what Electron already loads, and only that (#25)", () => {
  it("treats every library Electron NEEDS that mpv links as a host library", async () => {
    const target = await loadTarget("linux-x64");
    const host = findBundledHostLibraries(ELECTRON_PROVIDED, target.hostLibraries ?? []);
    console.info(`[media-deps:host] electron-provided matched=${host.join(",")} missing=${ELECTRON_PROVIDED.filter((name) => !host.includes(name)).join(",")}`);
    expect(host).toEqual(ELECTRON_PROVIDED);
  });

  it("never leaves an mpv-only library, or a soname only a host library pulls in, to the host", async () => {
    const target = await loadTarget("linux-x64");
    const wrong = findBundledHostLibraries(NOT_HOST_GLOBBED, target.hostLibraries ?? []);
    console.info(`[media-deps:host] must-stay-bundled wrongly host-globbed=${wrong.join(",") || "none"}`);
    expect(wrong).toEqual([]);
  });

  it("drops what only the host libraries pull in, and keeps the rest of the audio and X11 closure", async () => {
    const target = await loadTarget("linux-x64");
    const hostMatched = new Set(findBundledHostLibraries([...PUBLISHED.keys()], target.hostLibraries ?? []));
    const bundled = new Map([...PUBLISHED].filter(([name]) => !hostMatched.has(name)));
    const unreachable = findUnreachableLibraries(bundled, ["mpv", "ffmpeg", "ffprobe"]);
    const kept = [...bundled.keys()].filter((name) => !unreachable.includes(name));
    console.info(`[media-deps:host] host=${[...hostMatched].join(",")}`);
    console.info(`[media-deps:host] dropped-by-walk=${unreachable.join(",")} kept=${kept.join(",")}`);
    expect([...unreachable].sort()).toEqual([...PULLED_ONLY_BY_PROVIDED].sort());
    expect(kept).toEqual(expect.arrayContaining(MPV_ONLY));
  });
});
