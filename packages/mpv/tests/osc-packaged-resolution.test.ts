import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveMpvIcon,
  resolveMpvInputConf,
  resolveMpvOscScript,
  resolveMpvOscSelectScript,
  resolveMpvTog4in1FontsDir,
  resolveMpvTog4in1Script,
} from "../src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const touch = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "-- packaged\n");
};

// The installed layout (electron-builder extraResources): SF_APP_ROOT is
// <resources>/app.asar and the OSC files sit in <resources>/mpv/osc, beside it.
const makePackagedResources = () => {
  const resources = mkdtempSync(path.join(tmpdir(), "mpv-osc-packaged-"));
  roots.push(resources);
  const osc = path.join(resources, "mpv", "osc");
  touch(path.join(osc, "sf.lua"));
  touch(path.join(osc, "sf-select.lua"));
  touch(path.join(osc, "input.conf"));
  touch(path.join(osc, "tog4in1", "tog4in1.lua"));
  touch(path.join(osc, "tog4in1", "fonts", "font.ttf"));
  touch(path.join(resources, "mpv", "icons", "spacebadger.png"));
  return { resources, options: { appRoot: path.join(resources, "app.asar"), cwd: resources, env: {} } };
};

describe("packaged OSC resolution", () => {
  it("@bugfix finds the OSC lua files, input.conf, fonts and icon in <resources>/mpv beside app.asar", () => {
    const { resources, options } = makePackagedResources();
    const osc = path.join(resources, "mpv", "osc");
    expect(resolveMpvOscScript(options)).toBe(path.join(osc, "sf.lua"));
    expect(resolveMpvOscSelectScript(options)).toBe(path.join(osc, "sf-select.lua"));
    expect(resolveMpvInputConf(options)).toBe(path.join(osc, "input.conf"));
    expect(resolveMpvTog4in1Script(options)).toBe(path.join(osc, "tog4in1", "tog4in1.lua"));
    expect(resolveMpvTog4in1FontsDir(options)).toBe(path.join(osc, "tog4in1", "fonts"));
    expect(resolveMpvIcon(options)).toBe(path.join(resources, "mpv", "icons", "spacebadger.png"));
  });
});
