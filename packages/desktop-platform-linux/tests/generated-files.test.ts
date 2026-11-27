/**
 * @bugfix @regression-proof
 * The generated package scripts under an app's node_modules/.cache are rewritten by every call of its electron-builder
 * config, from several vitest workers at once. Written in place, a rewrite truncated the file under a worker that was
 * reading it, which read it empty (quick-checks run 55239: Parrot's linux-package-checks saw an empty after-install and
 * %posttrans). A rewrite now replaces the file whole, so an earlier reader keeps reading the complete old one.
 */
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeGeneratedFile } from "../packaging/generated-files.mjs";
import { rpmPosttransScript, writeLinuxScript } from "../packaging/linux-packages.mjs";
import { systemUpdateFpmFiles } from "../packaging/system-update.mjs";

const log = (line: string, data?: unknown) => console.info(`[generated-files] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-generated-files-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Everything the descriptor `fd` reads from its start. */
const readAll = (fd: number) => {
  const buffer = Buffer.alloc(1 << 16);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, length).toString("utf8");
};

describe("generated Linux package files", () => {
  it("a rewrite leaves a reader that opened the file before it with the whole old file", () => {
    const appDir = tmp();
    const first = ["#!/bin/bash", "echo first", ""].join("\n");
    const path = writeGeneratedFile(appDir, "after-install.tpl", first);
    const fd = openSync(path, "r");
    try {
      writeLinuxScript(appDir, "after-install.tpl", ["#!/bin/bash", "echo second, a longer script", ""]);
      const seen = readAll(fd);
      const now = readFileSync(path, "utf8");
      log("earlier reader / new file", { seen, now });
      expect(seen).toBe(first);
      expect(now).toBe("#!/bin/bash\necho second, a longer script\n");
    } finally {
      closeSync(fd);
    }
  });

  it("gives each file its mode and leaves no temporary file behind", () => {
    const appDir = tmp();
    const [helper, policy] = systemUpdateFpmFiles({ appDir, packageName: "spaceparrot", productName: "Parrot" }).map((arg) => arg.split("=")[0]);
    // twice, as every config call does
    systemUpdateFpmFiles({ appDir, packageName: "spaceparrot", productName: "Parrot" });
    const posttrans = rpmPosttransScript(appDir, "spaceparrot");
    const files = readdirSync(dirname(posttrans)).sort();
    log("files", { files, helper: statSync(helper).mode & 0o7777, policy: statSync(policy).mode & 0o7777 });
    expect(files).toEqual(["io.spacefleet.spaceparrot.update.policy", "rpm-posttrans.sh", "spaceparrot-system-update"]);
    expect(statSync(helper).mode & 0o7777).toBe(0o755);
    expect(statSync(policy).mode & 0o7777).toBe(0o644);
  });
});
