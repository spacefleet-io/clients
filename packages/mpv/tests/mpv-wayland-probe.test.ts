/**
 * @bugfix @regression-proof wayland-appid-option-not-found
 *
 * Every Wayland-only Linux launch passed `--wayland-appid`, which is not an mpv
 * option ("Error parsing option wayland-appid (option not found)", mpv exits at
 * once), and the bundled mpv then had no Wayland gpu context at all
 * (`--gpu-context=help` listed only x11egl). Playback died with nothing said.
 * Now the launch asks the mpv in use whether it has Wayland: yes ->
 * `--wayland-app-id` in a native Wayland window, no -> an X11 window when
 * there is a DISPLAY, else `noWindow` (the app shows a message).
 * MPV-GPU-04: the bundled mpv has Wayland (media-deps -Dwayland=enabled), and
 * a Wayland session uses it with DISPLAY taken out of mpv's environment.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMpvWindowEnv,
  buildExternalMpvArgs,
  mpvHasWayland,
  parseMpvGpuContexts,
  resetMpvWaylandProbeCache,
  resolveExternalMpvTarget,
  resolveExternalMpvWindow,
  type MpvGpuContextProbe,
  type ResolvedExternalMpvTarget,
} from "../src/external";

const TAG = "[mpv-wayland-probe]";

// Captured 2026-11-13: the bundled linux-x64 mpv 0.41.0 before MPV-GPU-04 (built -Dwayland=disabled), and Arch's mpv 0.41.0.
const NO_WAYLAND_HELP = "Available GPU contexts:\n  auto             Auto detect\n  x11egl           X11/EGL\n";
// The bundled linux-x64 mpv since MPV-GPU-04 (-Dwayland=enabled; media-deps verify printed "auto,wayland,x11egl").
const BUNDLED_HELP = "Available GPU contexts:\n  auto             Auto detect\n  wayland          Wayland/EGL\n  x11egl           X11/EGL\n";
const DISTRO_HELP = [
  "Available GPU contexts:",
  "  auto             Auto detect",
  "  waylandvk        Wayland/Vulkan",
  "  x11vk            X11/Vulkan",
  "  wayland          Wayland/EGL",
  "  x11egl           X11/EGL",
  "  x11              X11/GLX",
  "  drm              DRM/EGL",
  "  displayvk        VK_KHR_display",
  "",
].join("\n");

const bundle: ResolvedExternalMpvTarget = { bin: "/opt/sf/deps/bin/mpv", kind: "bundle", libDirs: ["/opt/sf/deps/bin"] };
const distro: ResolvedExternalMpvTarget = { bin: "/usr/bin/mpv", kind: "system", libDirs: [] };

const fakeProbe = (outputs: Record<string, { output: string; error: string | null }>) =>
  vi.fn<MpvGpuContextProbe>((target) => outputs[target.bin] ?? { output: "", error: "not found" });

afterEach(() => {
  resetMpvWaylandProbeCache();
  vi.unstubAllEnvs();
});

describe("parseMpvGpuContexts", () => {
  it("lists the contexts, without auto", () => {
    const bundled = parseMpvGpuContexts(BUNDLED_HELP);
    const noWayland = parseMpvGpuContexts(NO_WAYLAND_HELP);
    const distroContexts = parseMpvGpuContexts(DISTRO_HELP);
    console.info(`${TAG} bundled=${bundled.join(",")} noWayland=${noWayland.join(",")} distro=${distroContexts.join(",")}`);
    expect(bundled).toEqual(["wayland", "x11egl"]);
    expect(noWayland).toEqual(["x11egl"]);
    expect(distroContexts).toEqual(["waylandvk", "x11vk", "wayland", "x11egl", "x11", "drm", "displayvk"]);
    expect(parseMpvGpuContexts("")).toEqual([]);
  });
});

describe("mpvHasWayland", () => {
  it("is true for the bundled and a distro mpv, false for an mpv without a wayland context @req MPV-GPU-04[badger-desktop]", () => {
    const old: ResolvedExternalMpvTarget = { bin: "/opt/old/mpv", kind: "system", libDirs: [] };
    const probe = fakeProbe({
      [bundle.bin]: { output: BUNDLED_HELP, error: null },
      [distro.bin]: { output: DISTRO_HELP, error: null },
      [old.bin]: { output: NO_WAYLAND_HELP, error: null },
    });
    const bundled = mpvHasWayland(bundle, probe);
    const system = mpvHasWayland(distro, probe);
    const withoutWayland = mpvHasWayland(old, probe);
    console.info(`${TAG} bundle=${bundled} system=${system} noWayland=${withoutWayland} calls=${JSON.stringify(probe.mock.calls.map(([t]) => t.bin))}`);
    expect(bundled).toBe(true);
    expect(system).toBe(true);
    expect(withoutWayland).toBe(false);
  });

  it("asks each binary once per app session", () => {
    const probe = fakeProbe({ [distro.bin]: { output: DISTRO_HELP, error: null } });
    expect(mpvHasWayland(distro, probe)).toBe(true);
    expect(mpvHasWayland(distro, probe)).toBe(true);
    console.info(`${TAG} cached calls=${probe.mock.calls.length}`);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("counts a failed probe or a missing binary as no Wayland", () => {
    const failing = fakeProbe({ [distro.bin]: { output: DISTRO_HELP, error: "exit 1" } });
    expect(mpvHasWayland(distro, failing)).toBe(false);
    const never = fakeProbe({});
    expect(mpvHasWayland({ bin: "mpv", kind: "fallback", libDirs: [] }, never)).toBe(false);
    console.info(`${TAG} failing calls=${failing.mock.calls.length} fallback calls=${never.mock.calls.length}`);
    expect(never).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === "linux")("resolveExternalMpvWindow on Linux", () => {
  const waylandOnly = { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" };

  it("Wayland-only + mpv without Wayland: no window, no wayland flag", () => {
    const old: ResolvedExternalMpvTarget = { bin: "/opt/old/mpv", kind: "system", libDirs: [] };
    const probe = fakeProbe({ [old.bin]: { output: NO_WAYLAND_HELP, error: null } });
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: old, env: waylandOnly, probe });
    console.info(`${TAG} wayland-only no-wayland mpv -> ${JSON.stringify(window)}`);
    expect(window.noWindow).toBe("mpv_no_display");
    expect(window.args).toEqual([]);
  });

  it("Wayland-only + bundled mpv: native Wayland window, --wayland-app-id, wlshm CPU vo @req MPV-GPU-04[badger-desktop]", () => {
    const probe = fakeProbe({ [bundle.bin]: { output: BUNDLED_HELP, error: null } });
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: bundle, env: waylandOnly, probe });
    console.info(`${TAG} wayland-only bundle -> ${JSON.stringify(window)}`);
    expect(window).toEqual({ defaultVo: "gpu,wlshm", cpuVo: "wlshm", args: ["--wayland-app-id=spacebadger"], unsetEnv: [], noWindow: null });
    expect(window.args.some((arg) => arg.startsWith("--wayland-appid"))).toBe(false);
  });

  it("Wayland session with XWayland + bundled mpv: Wayland window, DISPLAY taken out of mpv's env @req MPV-GPU-04[badger-desktop]", () => {
    const probe = fakeProbe({ [bundle.bin]: { output: BUNDLED_HELP, error: null } });
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: bundle, env: { ...waylandOnly, DISPLAY: ":0" }, probe });
    const env = applyMpvWindowEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", KEEP: "1" }, window);
    console.info(`${TAG} xwayland bundle -> ${JSON.stringify(window)} env=${JSON.stringify(env)} calls=${probe.mock.calls.length}`);
    expect(window).toEqual({ defaultVo: "gpu,wlshm", cpuVo: "wlshm", args: ["--wayland-app-id=spacebadger"], unsetEnv: ["DISPLAY"], noWindow: null });
    expect(env).toEqual({ WAYLAND_DISPLAY: "wayland-0", KEEP: "1" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("an X11 session needs no probe @req MPV-GPU-04[badger-desktop]", () => {
    const probe = fakeProbe({});
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: bundle, env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, probe });
    const base = { DISPLAY: ":0" };
    console.info(`${TAG} x11 -> ${JSON.stringify(window)} calls=${probe.mock.calls.length}`);
    expect(window).toEqual({ defaultVo: "gpu,x11", cpuVo: "x11", args: ["--x11-name=spacebadger"], unsetEnv: [], noWindow: null });
    expect(applyMpvWindowEnv(base, window)).toBe(base);
    expect(probe).not.toHaveBeenCalled();
  });

  it("buildExternalMpvArgs on a Wayland-only session never passes the unknown --wayland-appid", () => {
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    const args = buildExternalMpvArgs({ url: "/fixtures/plain.mkv", target: { bin: "mpv", kind: "fallback", libDirs: [] } });
    const windowArgs = args.filter((arg) => arg.startsWith("--wayland") || arg.startsWith("--x11"));
    console.info(`${TAG} buildExternalMpvArgs window args=${JSON.stringify(windowArgs)}`);
    expect(windowArgs).toEqual([]);
  });

  // The real bundled binary, when this checkout has it (vendor/deps): since MPV-GPU-04 it lists a Wayland context.
  const real = resolveExternalMpvTarget();
  it.runIf(real.kind === "bundle")("the real bundled mpv reports a Wayland gpu context @req MPV-GPU-04[badger-desktop]", () => {
    const hasWayland = mpvHasWayland(real);
    console.info(`${TAG} real bundle ${real.bin} hasWayland=${hasWayland}`);
    expect(hasWayland).toBe(true);
  });
});
