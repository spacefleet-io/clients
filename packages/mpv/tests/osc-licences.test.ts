/**
 * @req REL-LIC-01
 * The desktop OSC ships only third-party files whose licence travels with them:
 * - tog4in1.lua derives from mpv's osc.lua and stays LGPL-2.1-or-later, with the licence text beside it;
 * - every font in tog4in1/fonts has its licence text (`<Stem>-OFL.txt`) next to it;
 * - the OSC names no font it does not ship (mpv-osd-symbols is mpv's own, built in).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TAG = "[osc-licences]";
const oscDir = fileURLToPath(new URL("../resources/osc/", import.meta.url));
const fontsDir = `${oscDir}tog4in1/fonts/`;
const tog4in1 = readFileSync(`${oscDir}tog4in1/tog4in1.lua`, "utf8");

describe("desktop OSC licences", () => {
  it("tog4in1.lua is LGPL-2.1-or-later, credits its lineage and ships the licence text", () => {
    const header = tog4in1.split("\n").slice(0, 25).join("\n");
    console.info(`${TAG} header:\n${header}`);
    expect(header).toMatch(/^-- SPDX-License-Identifier: LGPL-2\.1-or-later$/m);
    for (const credit of ["player/lua/osc.lua", "maoiscat", "cyl0", "zTnR", "Modified by SpaceFleet"]) {
      expect(header, credit).toContain(credit);
    }
    const lgpl = `${oscDir}LGPL-2.1.txt`;
    expect(existsSync(lgpl)).toBe(true);
    expect(readFileSync(lgpl, "utf8")).toContain("GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999");
  });

  it("every shipped font has its licence text beside it", () => {
    const files = readdirSync(fontsDir);
    const fonts = files.filter((f) => /\.(ttf|otf)$/i.test(f));
    console.info(`${TAG} fonts dir: ${files.join(", ")}`);
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const licence = `${font.replace(/\.(ttf|otf)$/i, "")}-OFL.txt`;
      expect(files, `${font} needs ${licence}`).toContain(licence);
    }
  });

  it("names only fonts it ships, or mpv's built-in symbol font", () => {
    const named = new Set([...tog4in1.matchAll(/createStyle\([^)]*,\s*"([^"]+)"\)/g)].map((m) => m[1]!));
    const oscFont = /oscFont = "([^"]+)"/.exec(tog4in1)?.[1];
    if (oscFont) named.add(oscFont);
    console.info(`${TAG} font names in tog4in1.lua: ${[...named].join(", ")}`);
    expect([...named].sort()).toEqual(["Inter", "Space Grotesk", "mpv-osd-symbols"]);
    expect(tog4in1).not.toMatch(/\\fn(?:material-design-iconic-font|modernx-osc-icon|oscc)\b|"(?:material-design-iconic-font|modernx-osc-icon|oscc)"/i);
  });
});
