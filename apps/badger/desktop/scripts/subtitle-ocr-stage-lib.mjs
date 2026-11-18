// PLAY-TRACK-05: the subtitle OCR child the runtime launches (`@space/ingest-core/subtitleOcr` cli.ts) ships as
// `<resources>/runtime/ocr/subtitle-ocr.js` beside a `node_modules/` holding tesseract.js and its runtime deps. The
// compiled runtime runs it as plain bun (`BUN_BE_BUN=1`, see resolveSubtitleOcrLauncher). tesseract.js stays external:
// it starts its worker thread and loads tesseract.js-core's wasm from files resolved inside its own package, which a
// bundle would lose.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Package whose dependency closure is copied into `runtime/ocr/node_modules`. */
export const SUBTITLE_OCR_EXTERNAL = "tesseract.js";

/** Staging dir of the OCR child, relative to the runtime stage dir (and to `<resources>/runtime`). */
export const SUBTITLE_OCR_DIR = "ocr";

/**
 * `bun build` arguments bundling the OCR CLI into one file, tesseract.js left external.
 * @param {string} entry absolute path of cli.ts
 * @param {string} outfile absolute path of subtitle-ocr.js
 * @returns {string[]}
 */
export const subtitleOcrBuildArgs = (entry, outfile) => [
  "build",
  entry,
  "--target=bun",
  "--external",
  SUBTITLE_OCR_EXTERNAL,
  "--define",
  'process.env.NODE_ENV="production"',
  "--outfile",
  outfile,
];

/**
 * Every package `name` needs at run time, resolved the way node/bun would from `fromDir` (each dependency from the
 * real dir of the package that declares it, so bun's isolated store works). Optional peers are not followed.
 * @param {string} fromDir
 * @param {string} name
 * @returns {Map<string, string>} package name → real package dir
 */
export const packageClosure = (fromDir, name) => {
  /** @type {Map<string, string>} */
  const found = new Map();
  /** @param {string} dir @param {string} pkg */
  const visit = (dir, pkg) => {
    if (found.has(pkg)) return;
    const manifest = realpathSync(createRequire(join(dir, "noop.js")).resolve(`${pkg}/package.json`));
    const pkgDir = dirname(manifest);
    found.set(pkg, pkgDir);
    const { dependencies = {} } = JSON.parse(readFileSync(manifest, "utf8"));
    for (const dep of Object.keys(dependencies)) visit(pkgDir, dep);
  };
  visit(fromDir, name);
  return found;
};
