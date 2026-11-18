import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The client entry must stay portable (Hermes, Electron renderer): no node:* and no Buffer in its import graph.
// There is no build step for this package (apps import the TypeScript), so the graph is walked from src/index.ts.
const src = resolve(import.meta.dirname, "../src");
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gu;

function walk(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) return seen;
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(IMPORT_RE)].map((m) => m[1]!);
  seen.set(file, specs);
  for (const spec of specs) if (spec.startsWith(".")) walk(resolve(dirname(file), `${spec}.ts`), seen);
  return seen;
}

describe("client entry portability", () => {
  const graph = walk(resolve(src, "index.ts"));

  it("reaches only portable modules", () => {
    console.log("[client-entry] modules:", [...graph.keys()].map((f) => f.replace(`${src}/`, "")).join(", "));
    expect(graph.size).toBeGreaterThan(5);
    expect([...graph.keys()].some((f) => f.endsWith("server.ts"))).toBe(false);
  });

  it("imports nothing from node:* and only @noble/hashes from outside", () => {
    const externals = new Set([...graph.values()].flat().filter((s) => !s.startsWith(".")));
    console.log("[client-entry] external imports:", [...externals].join(", "));
    expect([...externals].sort()).toEqual(["@noble/hashes/sha2.js"]);
  });

  it("uses no Buffer / atob / btoa / TextEncoder / require in the client sources", () => {
    for (const file of graph.keys()) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
        .join("\n");
      expect(code, file).not.toMatch(/\bBuffer\b|\batob\b|\bbtoa\b|\bTextEncoder\b|\brequire\(|\bprocess\./u);
    }
  });
});
