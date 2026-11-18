/**
 * @req PLAY-TRACK-05[badger-desktop]
 *
 * Every packaged build ships the subtitle OCR child: the bundled CLI plus
 * tesseract.js and its whole runtime dependency closure, no system install.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PACKAGE_TARGETS, requiredResourcesFor } from "../scripts/package-targets.mjs";
import { packageClosure, SUBTITLE_OCR_DIR, SUBTITLE_OCR_EXTERNAL, subtitleOcrBuildArgs } from "../scripts/subtitle-ocr-stage-lib.mjs";

const ingestCoreDir = resolve(import.meta.dirname, "..", "..", "..", "..", "packages", "ingest-core");

describe("subtitle OCR child staging (PLAY-TRACK-05)", () => {
  it("bundles the CLI for bun with tesseract.js left external", () => {
    const args = subtitleOcrBuildArgs("/repo/cli.ts", "/stage/runtime/ocr/subtitle-ocr.js");
    expect(args.slice(0, 3)).toEqual(["build", "/repo/cli.ts", "--target=bun"]);
    expect(args[args.indexOf("--external") + 1]).toBe(SUBTITLE_OCR_EXTERNAL);
    expect(args.at(-1)).toBe("/stage/runtime/ocr/subtitle-ocr.js");
    expect(SUBTITLE_OCR_DIR).toBe("ocr");
  });

  it("collects tesseract.js with its wasm core and every runtime dependency", () => {
    const closure = packageClosure(ingestCoreDir, SUBTITLE_OCR_EXTERNAL);
    expect([...closure.keys()]).toEqual(expect.arrayContaining(["tesseract.js", "tesseract.js-core", "regenerator-runtime", "node-fetch", "zlibjs"]));
    for (const dir of closure.values()) expect(existsSync(join(dir, "package.json"))).toBe(true);
    // node-fetch's own dependency is followed too (closure, not just direct deps).
    expect(closure.has("whatwg-url")).toBe(true);
  });

  it("is required in every packaged target", () => {
    for (const target of Object.values(PACKAGE_TARGETS)) {
      expect(requiredResourcesFor(target)).toEqual(
        expect.arrayContaining([
          "runtime/ocr/subtitle-ocr.js",
          "runtime/ocr/node_modules/tesseract.js/package.json",
          "runtime/ocr/node_modules/tesseract.js-core/package.json",
        ]),
      );
    }
  });
});
