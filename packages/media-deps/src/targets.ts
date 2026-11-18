import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getPackageRoot } from "./plan";
import type { DepsTarget, DesktopDepsTarget, MobileDepsTarget } from "./target";

/**
 * Discovers every recipe (`recipes/<id>/target.ts`). No shared file lists the targets, so adding an
 * OS (macos-arm64 …) touches only its own recipe directory.
 */
export const loadTargets = async (packageRoot = getPackageRoot()): Promise<DepsTarget[]> => {
  const recipesDir = path.join(packageRoot, "recipes");
  const ids = readdirSync(recipesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(recipesDir, id, "target.ts")))
    .sort();
  const targets: DepsTarget[] = [];
  for (const id of ids) {
    // Dynamic: recipe directories are discovered at runtime, so no static import can list them.
    const mod = (await import(path.join(recipesDir, id, "target.ts"))) as { default: DepsTarget };
    if (mod.default.id !== id) throw new Error(`target_id_mismatch:${id}:${mod.default.id}`);
    targets.push(mod.default);
  }
  return targets;
};

export const loadTarget = async (id: string, packageRoot = getPackageRoot()): Promise<DepsTarget> => {
  const found = (await loadTargets(packageRoot)).find((target) => target.id === id);
  if (!found) throw new Error(`unknown_target:${id}`);
  return found;
};

export const loadDesktopTarget = async (id: string, packageRoot = getPackageRoot()): Promise<DesktopDepsTarget> => {
  const target = await loadTarget(id, packageRoot);
  if (target.kind !== "desktop") throw new Error(`not_a_desktop_target:${id}`);
  return target;
};

export const loadMobileTarget = async (id: string, packageRoot = getPackageRoot()): Promise<MobileDepsTarget> => {
  const target = await loadTarget(id, packageRoot);
  if (target.kind !== "mobile") throw new Error(`not_a_mobile_target:${id}`);
  return target;
};

/**
 * The desktop target whose bundle runs on a machine with this Node `process.platform` / `process.arch`
 * (the entry-point scripts pass them in: this module holds no OS checks). Each desktop recipe declares its
 * own `nodePlatform`, so a new OS needs no edit here. Mobile targets never run on a build host.
 */
export const hostTarget = async (nodePlatform: string, arch: string, packageRoot = getPackageRoot()): Promise<DesktopDepsTarget> => {
  const found = (await loadTargets(packageRoot)).find(
    (target): target is DesktopDepsTarget => target.kind === "desktop" && target.nodePlatform === nodePlatform && target.arch === arch
  );
  if (!found) throw new Error(`unsupported_host:${nodePlatform}-${arch}`);
  return found;
};
