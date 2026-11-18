/**
 * Run the desktop platform conformance suite against the current OS and print
 * TAP. Exit code 1 when any check fails.
 *
 *   bun packages/desktop-platform/src/conformance-cli.ts [--only id,id] [--json] [--expect-ok N] [--helper path]
 *
 * `--expect-ok N` also exits 1 when fewer than N checks are `ok` (a skipped check
 * is not a pass): the Windows quick test runs it with 19. `--helper path` is the
 * module the helper processes import (default: the sibling helper-platform.ts);
 * a bundled or compiled CLI has no sibling file, so it is passed explicitly.
 *
 * This is the command used on the Windows VM and on the future macOS runner.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTap, runConformance } from "@space/desktop-platform-contract/conformance";
import { getDesktopPlatform } from "./index";

const args = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = valueOf("--only")?.split(",").filter(Boolean);
const expectOkText = valueOf("--expect-ok");
const expectOk = expectOkText === undefined ? undefined : Number(expectOkText);
if (args.includes("--expect-ok") && (expectOk === undefined || !Number.isInteger(expectOk) || expectOk < 0)) {
  console.error(`conformance: --expect-ok needs a count, got ${JSON.stringify(expectOkText)}`);
  process.exit(2);
}
// A `bun build --compile` executable spawns itself for the helper scripts: BUN_BE_BUN makes it behave as the bun CLI there.
if (basename(process.execPath).toLowerCase().replace(/\.exe$/, "") !== "bun") process.env.BUN_BE_BUN = "1";

const platform = getDesktopPlatform();
// The helper processes load the implementation by path; the selector is that module.
const helperModule = valueOf("--helper") ?? fileURLToPath(new URL("./helper-platform.ts", import.meta.url));
const results = await runConformance(platform, helperModule, {
  only,
  log: (line) => console.error(`# ${line}`),
});
if (args.includes("--json")) console.log(JSON.stringify({ platform: `${platform.id}-${platform.arch}`, results }, null, 2));
else console.log(formatTap(platform, results));
const ok = results.filter((result) => result.status === "ok").length;
if (expectOk !== undefined && ok < expectOk) console.error(`conformance: ${ok} of ${expectOk} expected checks ok`);
process.exit(results.some((result) => result.status === "failed") || (expectOk !== undefined && ok < expectOk) ? 1 : 0);
