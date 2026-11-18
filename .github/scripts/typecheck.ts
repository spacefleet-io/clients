#!/usr/bin/env bun
// Type-checks every TypeScript project of this repository: each tsconfig*.json under apps/ and packages/
// runs as `tsc -p <it> --noEmit` with the root typescript, a few at a time.
//
//   bun .github/scripts/typecheck.ts
//
// Any error fails the run, except errors in the files .github/known-type-errors.txt lists: each of those
// also fails the type check upstream, in SpaceFleet's repository where this code is developed. A listed file
// that no longer has an error fails the run too, so the list only ever shrinks.
import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { UPSTREAM_TOO } from "./ci-test";

const ROOT = join(import.meta.dir, "..", "..");
export const KNOWN_TYPE_ERRORS = ".github/known-type-errors.txt";

/** Every tsconfig*.json under `root`'s apps/ and packages/, repo-relative and sorted. */
export const findProjects = (root: string): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : walk(join(dir, entry.name));
      return /^tsconfig[^/]*\.json$/.test(entry.name) ? [relative(root, join(dir, entry.name))] : [];
    });
  return ["apps", "packages"].flatMap((top) => walk(join(root, top))).sort();
};

/** Parses the list: `<file><TAB><reason>` per line, `#` comments and blank lines ignored. */
export const parseKnownTypeErrors = (text: string): Map<string, string> => {
  const known = new Map<string, string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    const [path, reason, ...rest] = line.split("\t");
    if (!path || !reason || rest.length > 0) throw new Error(`${KNOWN_TYPE_ERRORS}:${index + 1}: expected <file><TAB><reason>`);
    if (!reason.endsWith(UPSTREAM_TOO)) throw new Error(`${KNOWN_TYPE_ERRORS}:${index + 1}: the reason must end with "${UPSTREAM_TOO}"`);
    known.set(path, reason);
  });
  return known;
};

/** The file a `tsc` diagnostic line names (`path(line,col): error TS…`), or null for any other line. */
export const diagnosticFile = (line: string): string | null => /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line)?.[1] ?? null;

if (import.meta.main) {
  const known = parseKnownTypeErrors(readFileSync(join(ROOT, KNOWN_TYPE_ERRORS), "utf8"));
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const queue = findProjects(ROOT);
  console.log(`[typecheck] ${queue.length} projects, ${known.size} files with known type errors`);
  const failed: string[] = [];
  const stillFailing = new Set<string>();
  const worker = async (): Promise<void> => {
    for (let project = queue.shift(); project; project = queue.shift()) {
      const run = Bun.spawn(["bun", tsc, "-p", project, "--noEmit", "--pretty", "false"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
      // A diagnostic's continuation lines are indented; every other non-empty line is new and must be a known file's error.
      const unexpected = (out + err).split("\n").filter((line) => {
        if (line.trim() === "" || line.startsWith(" ")) return false;
        const file = diagnosticFile(line);
        if (file && known.has(file)) {
          stillFailing.add(file);
          return false;
        }
        return true;
      });
      const ok = unexpected.length === 0 && (code === 0 || out + err !== "");
      console.log(`[typecheck] ${ok ? "ok  " : "FAIL"} ${project}`);
      if (!ok) {
        failed.push(project);
        console.log(unexpected.join("\n") || `tsc exited with ${code} and printed nothing`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, availableParallelism() - 1)) }, worker));
  const fixed = [...known.keys()].filter((file) => !stillFailing.has(file));
  for (const file of fixed) console.error(`[typecheck] ${file} has no type error any more: remove its line from ${KNOWN_TYPE_ERRORS}`);
  if (failed.length > 0) console.error(`[typecheck] ${failed.length} project(s) failed: ${failed.join(", ")}`);
  if (failed.length > 0 || fixed.length > 0) process.exit(1);
  console.log(`[typecheck] ok; known errors ignored in ${known.size} files, each also failing upstream`);
}
