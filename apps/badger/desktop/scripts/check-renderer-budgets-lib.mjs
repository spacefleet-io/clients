import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Chunks are resolved EXACTLY from the Vite build manifest
// (`build.manifest: true` in the renderer block of electron.vite.config.ts),
// never by filename prefix: several shared chunks are named `index-*.js`, and
// the old "first sorted `index-` file" match measured a ~1.5 KiB helper instead
// of the entry, so the entry budget could never fail (issue #25).
//
// A budget names its chunk in one of two ways:
// - `src`: the manifest `src` of an entry chunk, relative to the renderer root
//   (`src/renderer`). The renderer entry is `index.html`.
// - `chunkName`: the exact rollup chunk name (module basename, the part of the
//   filename before the hash). Used for lazy and shared chunks: a dynamic-import
//   chunk that rollup merged with sibling modules (AuthenticatedApp, today) has
//   no facade module and so no `src` in the manifest, but keeps its name.
// A budget that resolves to zero or several JS chunks fails the check.
/**
 * @typedef {{ name: string; src?: string; chunkName?: string; maxBytes: number }} RendererBudget
 * @typedef {{ file?: unknown; name?: string; src?: string; isEntry?: boolean }} ManifestChunk
 * @typedef {RendererBudget & ({ file: string; bytes: number; reason?: undefined } | { file: null; bytes: null; reason: string })} RendererBudgetEntry
 * @typedef {{ missing: RendererBudgetEntry[]; violations: RendererBudgetEntry[] }} RendererBudgetEvaluation
 */
export const RENDERER_MANIFEST_PATH = join(".vite", "manifest.json");

/** @type {RendererBudget[]} */
export const DEFAULT_RENDERER_BUDGETS = [
  // The entry is startup cost on the low-end target (old i5, no GPU): trim
  // instead of raising. Issue #25 found it at 950.26 KiB once it was measured
  // for real; the e2e-only renderer perf probe (lib/e2ePerfProbe.ts) then moved
  // behind a dynamic import (945.95 KiB).
  //
  // Lowered 950 → 805 KiB (issue #25). The en/fr locales are now per-locale
  // lazy chunks (only the active one loads, before the first render) and the
  // storage tunnel client loads on first use after login: entry measured
  // 781.79 KiB. 805 is that plus ~3% headroom.
  { name: "index", src: "index.html", maxBytes: 805 * 1024 },
  // Bumped 200 → 220 KiB after the production-grade ABR wire-up landed. ABR
  // added a renderer bandwidth estimator (since replaced by the main-process
  // link meter, issue #25), the playbackAbr decision module, the 1Hz
  // observation loop in useMpvPlaybackEngine, the force-quality Setting,
  // and new i18n keys. ~9 KiB legitimate growth — the headroom to 220 leaves
  // room for the next iteration without immediately needing another bump.
  //
  // Bumped 220 → 222 KiB for the library-format compatibility gate. The
  // `parseLibraryFormatTooNew` detector + `formatTooNew` state plumbing live in
  // libraryContext.tsx, which is eagerly imported on the library-load path —
  // the gate must run before any decrypt. The modal + electron-updater bundle
  // are split out (lazy LibraryUpdateGate); only the detector is unavoidably
  // eager. ~0.5 KiB; 222 leaves a small headroom.
  //
  // Bumped 222 → 248 KiB for the metadata-language feature (original-language
  // titles + per-device-UI-language descriptions + the synced
  // library_metadata_language setting; commits 961452a8 / 5cf408e2 / ebe99263).
  // Its language-aware plumbing in libraryContext, the metadata-language
  // settings UI, and the effectiveTitleLang resolver are eagerly bundled into
  // AuthenticatedApp; measured 241.41 KiB. The feature landed WITHOUT bumping
  // this budget, so the violation only surfaced once the (unrelated) unused-
  // eslint-disable lint debt was cleared and ci:desktop reached the budget
  // check. 248 accommodates the legitimate growth with ~6.6 KiB headroom;
  // consider lazy-loading the metadata-language settings UI if it grows again.
  //
  // Bumped 248 → 252 KiB after the localized-episodes + media-language-display
  // additions (new useLocalizedEpisodes hook + metadata.ts localization
  // helpers + mediaLanguageDisplay helpers, all eagerly bundled in
  // AuthenticatedApp). Measured 248.97 KiB. 252 gives ~3 KiB headroom; if this
  // budget needs a third bump, factor the eager language helpers behind a
  // lazy-loaded namespace.
  //
  // Bumped 252 → 264 KiB (issue #25). The budget check only ran in local
  // ci:desktop, never in PR CI, so two overruns landed unnoticed: the
  // 2026-06-04 offline-mode work in
  // libraryContext (356b6010 friendly offline labels +1.1 KiB, 2824ccea
  // bidirectional offline mode +4.1 KiB → 256.15 KiB) and #67's
  // librarySnapshotPersister (+3.45 KiB → 259.60 KiB, 2026-10-06). All of it is
  // library state code that must be live when the authenticated shell mounts.
  // #64 / #65 / #70 did not grow it. 264 gives ~4.4 KiB headroom. Next trim
  // candidates: the eager language helpers above, and lazy-loading the
  // snapshot persister once its flush-before-destroy path allows it.
  //
  // Bumped 264 → 265 KiB (issue #25, PR #86). Staging measured 263.75 KiB;
  // #86 adds 0.73 KiB → 264.48 KiB, all library-load code live when the
  // authenticated shell mounts: classifyLibraryOpenFallback (an IPC-wrapped
  // SYNC_UNAVAILABLE now falls back to the local library instead of
  // hard-failing), the per-await activateRemoteLibrary step log (diagnostic
  // logs are kept, never stripped for size), and the shell's restore-origin
  // ref. 265 is the smallest whole-KiB budget that holds it; the trim
  // candidates above still stand.
  //
  // Bumped 265 → 266 KiB (issue #145, PR #196). Staging measured 264.96 KiB;
  // #196 adds 0.07 KiB → 265.03 KiB: the shared storage tunnel's per-media
  // placement acquire/resolve (one media stays on one silo), live in the
  // shell because uploads/playback resolve through it. 266 is the smallest
  // whole-KiB budget that holds it; the trim candidates above still stand.
  { name: "AuthenticatedApp", chunkName: "AuthenticatedApp", maxBytes: 266 * 1024 },
  // Bumped 35 → 45 KiB after enabling React Compiler. TopNav grew to 40.57 KiB
  // due to 13 inlined memo cache slots — the largest density in the renderer.
  // Bumped 45 → 51 KiB at f2c28a06 (2026-10-16): TopNav's own code is unchanged, but Rollup
  // re-homed the shared Sheet/Dialog primitives into this chunk (41.49 → 47.91 KiB). ~3 KiB headroom.
  { name: "TopNav", chunkName: "TopNav", maxBytes: 51 * 1024 },
  // Lazy successor of the deleted LabQueuePanel budget. Measured 30.07 KiB
  // (unchanged since fe663b9b, 2026-06-03); 33 gives ~3 KiB headroom.
  { name: "TopNavJobsSidebarContent", chunkName: "TopNavJobsSidebarContent", maxBytes: 33 * 1024 },
  { name: "FileIngestionDialog", chunkName: "FileIngestionDialog", maxBytes: 460 * 1024 },
];

/**
 * @param {string} rendererDir
 * @returns {Record<string, ManifestChunk>}
 */
export const readRendererManifest = (rendererDir) => {
  const manifestPath = join(rendererDir, RENDERER_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Renderer build manifest not found: ${manifestPath}. The renderer build must set build.manifest: true (electron.vite.config.ts).`
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
};

const describeSelector = (budget) => (budget.src ? `src "${budget.src}"` : `chunk name "${budget.chunkName}"`);

const matchesBudget = (budget, chunk) => {
  if (typeof chunk.file !== "string" || !chunk.file.endsWith(".js")) return false;
  if (budget.src) return chunk.isEntry === true && chunk.src === budget.src;
  return chunk.name === budget.chunkName;
};

/**
 * @param {string} rendererDir
 * @param {Record<string, ManifestChunk>} manifest
 * @param {RendererBudget[]} [budgets]
 * @param {(path: string) => { size: number }} [statSyncImpl]
 * @returns {RendererBudgetEntry[]}
 */
export const collectRendererBudgetEntries = (
  rendererDir,
  manifest,
  budgets = DEFAULT_RENDERER_BUDGETS,
  statSyncImpl = statSync
) =>
  budgets.map((budget) => {
    const candidates = Object.values(manifest).filter((chunk) => matchesBudget(budget, chunk));
    if (candidates.length !== 1) {
      return {
        ...budget,
        file: null,
        bytes: null,
        reason: `${describeSelector(budget)} matched ${candidates.length} chunks${
          candidates.length > 0 ? ` (${candidates.map((chunk) => chunk.file).join(", ")})` : ""
        }`,
      };
    }
    const { file } = candidates[0];
    return { ...budget, file, bytes: statSyncImpl(join(rendererDir, file)).size };
  });

/**
 * @param {RendererBudgetEntry[]} entries
 * @returns {RendererBudgetEvaluation}
 */
export const evaluateRendererBudgets = (entries) => ({
  missing: entries.filter((entry) => entry.file === null),
  violations: entries.filter((entry) => entry.bytes !== null && entry.bytes > entry.maxBytes),
});

const formatKiB = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;

/**
 * @param {RendererBudgetEvaluation & { entries: RendererBudgetEntry[] }} result
 * @returns {string}
 */
export const formatRendererBudgetReport = ({ entries, missing, violations }) => {
  const lines = ["Renderer chunk budgets:"];
  for (const entry of entries) {
    lines.push(
      `- ${entry.name}: ${entry.file ?? "missing"} (${entry.bytes === null ? "missing" : formatKiB(entry.bytes)} / budget ${formatKiB(entry.maxBytes)})`
    );
  }
  if (missing.length === 0 && violations.length === 0) {
    lines.push("", "All renderer chunk budgets passed.");
    return `${lines.join("\n")}\n`;
  }

  if (missing.length > 0) {
    lines.push("", "Missing expected renderer chunks:");
    lines.push(...missing.map((entry) => `- ${entry.name}: ${entry.reason ?? "not found"}`));
  }
  if (violations.length > 0) {
    lines.push("", "Renderer chunk budget violations:");
    lines.push(
      ...violations.map(
        (entry) => `- ${entry.name}: ${formatKiB(entry.bytes ?? 0)} > ${formatKiB(entry.maxBytes)} (${entry.file})`
      )
    );
  }
  return `${lines.join("\n")}\n`;
};
