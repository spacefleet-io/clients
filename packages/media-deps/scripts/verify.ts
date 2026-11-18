import path from "node:path";
import { getPackageRoot, hostTarget, loadTarget, verifyTarget } from "../src/index";
import { parseArgs } from "./_args";

/**
 * Runs the verifier against a bundle directory on THIS machine (it must be the target's OS: run it
 * on the Windows VM for windows-x64, on a Mac for macos-*).
 * Usage: bun scripts/verify.ts [--target <id>] [--bundle <dir>]   (default: <repo>/vendor/deps/<id>)
 */
const args = parseArgs(process.argv.slice(2));
const target =
  typeof args.target === "string" ? await loadTarget(args.target) : await hostTarget(process.platform, process.arch);
const packageRoot = getPackageRoot();
const bundleDir =
  typeof args.bundle === "string" ? path.resolve(args.bundle) : path.join(packageRoot, "..", "..", "vendor", "deps", target.id);
const result = await verifyTarget({
  bundleDir,
  target,
  hostPlatform: process.platform,
  oscScript: path.resolve(packageRoot, "..", "mpv", "resources", "osc", "sf.lua"),
});
console.info(`[media-deps:verify] ${target.id}: ${result.passed.length} passed, ${result.failures.length} failed`);
if (!result.ok) process.exit(1);
