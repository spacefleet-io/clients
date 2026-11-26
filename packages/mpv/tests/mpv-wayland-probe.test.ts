/**
 * @bugfix @regression-proof wayland-appid-option-not-found
 *
 * Every Wayland-only Linux launch passed `--wayland-appid`, which is not an mpv
 * option ("Error parsing option wayland-appid (option not found)", mpv exits at
 * once), and the bundled mpv has no Wayland gpu context at all (media-deps builds
 * -Dwayland=disabled; `--gpu-context=help` lists only x11egl). Playback died
 * with nothing said. Now the launch asks the mpv in use whether it has Wayland:
 * yes -> `--wayland-app-id`, no -> `noWindow` (the app shows a message).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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

// Captured 2026-11-13: the bundled linux-x64 mpv 0.41.0, and Arch's mpv 0.41.0.
const BUNDLED_HELP = "Available GPU contexts:\n  auto             Auto detect\n  x11egl           X11/EGL\n";
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
    const distroContexts = parseMpvGpuContexts(DISTRO_HELP);
    console.info(`${TAG} bundled=${bundled.join(",")} distro=${distroContexts.join(",")}`);
    expect(bundled).toEqual(["x11egl"]);
    expect(distroContexts).toEqual(["waylandvk", "x11vk", "wayland", "x11egl", "x11", "drm", "displayvk"]);
    expect(parseMpvGpuContexts("")).toEqual([]);
  });
});

describe("mpvHasWayland", () => {
  it("is false for the bundled mpv and true for an mpv with a wayland context", () => {
    const probe = fakeProbe({ [bundle.bin]: { output: BUNDLED_HELP, error: null }, [distro.bin]: { output: DISTRO_HELP, error: null } });
    const bundled = mpvHasWayland(bundle, probe);
    const system = mpvHasWayland(distro, probe);
    console.info(`${TAG} bundle=${bundled} system=${system} calls=${JSON.stringify(probe.mock.calls.map(([t]) => t.bin))}`);
    expect(bundled).toBe(false);
    expect(system).toBe(true);
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

  it("Wayland-only + bundled mpv: no window, no wayland flag", () => {
    const probe = fakeProbe({ [bundle.bin]: { output: BUNDLED_HELP, error: null } });
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: bundle, env: waylandOnly, probe });
    console.info(`${TAG} wayland-only bundle -> ${JSON.stringify(window)}`);
    expect(window.noWindow).toBe("mpv_no_display");
    expect(window.args).toEqual([]);
  });

  it("Wayland-only + mpv with Wayland: --wayland-app-id, never --wayland-appid", () => {
    const probe = fakeProbe({ [distro.bin]: { output: DISTRO_HELP, error: null } });
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: distro, env: waylandOnly, probe });
    console.info(`${TAG} wayland-only distro -> ${JSON.stringify(window)}`);
    expect(window.noWindow).toBeNull();
    expect(window.args).toEqual(["--wayland-app-id=spacebadger"]);
  });

  it("an X display needs no probe", () => {
    const probe = fakeProbe({});
    const window = resolveExternalMpvWindow({ appId: "spacebadger", target: bundle, env: { ...waylandOnly, DISPLAY: ":0" }, probe });
    console.info(`${TAG} xwayland -> ${JSON.stringify(window)} calls=${probe.mock.calls.length}`);
    expect(window).toEqual({ defaultVo: "gpu,x11", cpuVo: "x11", args: ["--x11-name=spacebadger"], noWindow: null });
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

  // The real bundled binary, when this checkout has it (vendor/deps): it must answer "no Wayland".
  const real = resolveExternalMpvTarget();
  it.runIf(real.kind === "bundle")("the real bundled mpv reports no Wayland gpu context", () => {
    const hasWayland = mpvHasWayland(real);
    console.info(`${TAG} real bundle ${real.bin} hasWayland=${hasWayland}`);
    expect(hasWayland).toBe(false);
  });
});
