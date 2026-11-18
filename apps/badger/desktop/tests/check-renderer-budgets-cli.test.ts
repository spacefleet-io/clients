/**
 * @bugfix @regression-proof issue #25: `check:renderer-budgets` (ci:desktop)
 * matched budgets by filename prefix and took the first sorted hit. Several
 * shared chunks are named `index-*.js`, so the ~950 KiB entry budget measured a
 * ~1.5 KiB helper chunk and could never go red; any chunk whose name merely
 * starts with a budgeted one (`AuthenticatedApp-legacy-*.js`) would likewise
 * satisfy a budget whose real chunk is gone. These tests run the
 * real CLI against a synthetic `out/renderer` tree
 * (copied script + lib, so the CLI resolves its own `../out/renderer`) and
 * assert on its exit code and report.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PREFIX = "[check-renderer-budgets-cli]";
const SCRIPTS_DIR = join(__dirname, "..", "scripts");
const KiB = 1024;

type FixtureChunk = {
  /** Vite manifest key (source path relative to the renderer root, or `_<file>` for shared chunks). */
  key: string;
  file: string;
  name: string;
  bytes: number;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
};

/** Mirrors the shape of a real badger renderer build (electron-vite, renderer root `src/renderer`). */
const baseChunks = (entryBytes: number): FixtureChunk[] => [
  // Shared helper chunk that sorts BEFORE the real entry — the one the old prefix match picked.
  { key: "_index-AAAAAAAA.js", file: "assets/index-AAAAAAAA.js", name: "index", bytes: 1573 },
  { key: "_index-BBBBBBBB.js", file: "assets/index-BBBBBBBB.js", name: "index", bytes: 74 * KiB },
  { key: "index.html", src: "index.html", isEntry: true, file: "assets/index-ZZZZZZZZ.js", name: "index", bytes: entryBytes },
  {
    // Rollup merged sibling modules into this dynamic-import chunk, so it has no
    // facade module and therefore no `src` in the manifest (true of the real build).
    key: "_AuthenticatedApp-CCCCCCCC.js",
    isDynamicEntry: true,
    file: "assets/AuthenticatedApp-CCCCCCCC.js",
    name: "AuthenticatedApp",
    bytes: 100 * KiB,
  },
  { key: "_TopNav-DDDDDDDD.js", file: "assets/TopNav-DDDDDDDD.js", name: "TopNav", bytes: 20 * KiB },
  {
    key: "src/components/TopNavJobsSidebarContent.tsx",
    src: "src/components/TopNavJobsSidebarContent.tsx",
    isDynamicEntry: true,
    file: "assets/TopNavJobsSidebarContent-EEEEEEEE.js",
    name: "TopNavJobsSidebarContent",
    bytes: 10 * KiB,
  },
  {
    key: "src/components/FileIngestionDialog.tsx",
    src: "src/components/FileIngestionDialog.tsx",
    isDynamicEntry: true,
    file: "assets/FileIngestionDialog-FFFFFFFF.js",
    name: "FileIngestionDialog",
    bytes: 100 * KiB,
  },
];

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const buildFixture = (label: string, chunks: FixtureChunk[]) => {
  const root = mkdtempSync(join(tmpdir(), `sf-renderer-budgets-${label}-`));
  tempRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const file of ["check-renderer-budgets.mjs", "check-renderer-budgets-lib.mjs"]) {
    copyFileSync(join(SCRIPTS_DIR, file), join(root, "scripts", file));
  }
  const rendererDir = join(root, "out", "renderer");
  mkdirSync(join(rendererDir, "assets"), { recursive: true });
  mkdirSync(join(rendererDir, ".vite"), { recursive: true });
  const manifest: Record<string, Omit<FixtureChunk, "key" | "bytes">> = {};
  for (const { key, bytes, ...chunk } of chunks) {
    writeFileSync(join(rendererDir, chunk.file), Buffer.alloc(bytes, 0x61));
    manifest[key] = chunk;
  }
  writeFileSync(join(rendererDir, ".vite", "manifest.json"), JSON.stringify(manifest, null, 2));
  const entry = chunks.find((chunk) => chunk.isEntry);
  writeFileSync(
    join(rendererDir, "index.html"),
    `<!doctype html><html><head>${entry ? `<script type="module" crossorigin src="./${entry.file}"></script>` : ""}</head><body><div id="root"></div></body></html>`,
  );
  console.info(
    `${PREFIX}:${label} fixture root=${root} assets=${JSON.stringify(readdirSync(join(rendererDir, "assets")).sort())}`,
  );
  return root;
};

const runCli = (label: string, root: string) => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "check-renderer-budgets.mjs")], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  console.info(`${PREFIX}:${label} exit=${result.status} signal=${result.signal ?? "none"}`);
  console.info(`${PREFIX}:${label} stdout:\n${result.stdout}`);
  console.info(`${PREFIX}:${label} stderr:\n${result.stderr}`);
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
};

describe("check-renderer-budgets CLI (issue #25)", () => {
  it("passes when every budgeted chunk resolves and fits", () => {
    const root = buildFixture("green", baseChunks(500 * KiB));
    const { status, output } = runCli("green", root);
    expect(output).toContain("index-ZZZZZZZZ.js");
    expect(status).toBe(0);
  });

  it("fails when the real renderer entry is over budget, even though a tiny index-* helper sorts first", () => {
    const root = buildFixture("entry-over", baseChunks(2048 * KiB));
    const { status, output } = runCli("entry-over", root);
    // Measured file must be the entry index.html loads, not the 1.5 KiB helper.
    expect(output).toContain("index-ZZZZZZZZ.js");
    expect(output).not.toMatch(/index: assets\/index-AAAAAAAA\.js|index: index-AAAAAAAA\.js/);
    expect(output).toContain("Renderer chunk budget violations:");
    expect(status).toBe(1);
  });

  it("fails when a budgeted chunk is absent, even if a chunk with a longer name sharing its prefix exists", () => {
    const chunks = baseChunks(500 * KiB).filter((chunk) => chunk.name !== "AuthenticatedApp");
    // `AuthenticatedApp-legacy-*.js` starts with `AuthenticatedApp-`: the old prefix match accepted it.
    chunks.push({
      key: "src/AuthenticatedApp-legacy.tsx",
      src: "src/AuthenticatedApp-legacy.tsx",
      isDynamicEntry: true,
      file: "assets/AuthenticatedApp-legacy-GGGGGGGG.js",
      name: "AuthenticatedApp-legacy",
      bytes: 1 * KiB,
    });
    const root = buildFixture("missing", chunks);
    const { status, output } = runCli("missing", root);
    expect(output).toContain("Missing expected renderer chunks:");
    expect(output).toMatch(/Missing expected renderer chunks:\n- AuthenticatedApp\b/);
    expect(status).toBe(1);
  });

  it("fails loudly when the build has no Vite manifest", () => {
    const root = buildFixture("no-manifest", baseChunks(500 * KiB));
    rmSync(join(root, "out", "renderer", ".vite"), { recursive: true, force: true });
    const { status, output } = runCli("no-manifest", root);
    expect(output).toMatch(/manifest/i);
    expect(status).toBe(1);
  });
});
