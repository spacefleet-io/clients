/**
 * REL-UPD-07: a .deb/.rpm/.pacman install of Badger or Parrot updates itself through the system's package manager after
 * the desktop's password dialog. The root side is one helper per package (`/usr/lib/<pkg>/system-update`) that takes no
 * argument and updates that package alone, plus a polkit action naming that one program. These tests pin the helper's
 * fixed inputs, its "only this package" checks (run against fake package managers) and the packaging wiring.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SYSTEM_UPDATE_EXIT,
  systemUpdateActionId,
  systemUpdateFpmFiles,
  systemUpdateHelperLines,
  systemUpdateHelperPath,
  systemUpdatePolicy,
} from "../packaging/system-update.mjs";

const log = (line: string, data?: unknown) => console.info(`[system-update] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-system-update-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const script = (pkg = "spacebadger") => systemUpdateHelperLines(pkg).join("\n");

/**
 * Runs the helper with fake package-manager commands first on PATH and /etc/ moved under a temporary folder.
 * `fakes` maps a command name to a bash body; every fake call is appended to `calls` as "<name> <args>".
 */
const simulate = (fakes: Record<string, string>, etc: Record<string, string>, args: string[] = []) => {
  const root = tmp();
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >>'${calls}'\n${body.replaceAll("__CALLS__", calls)}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("id", 'echo 0');
  for (const [name, body] of Object.entries(fakes)) fake(name, body);
  for (const [path, content] of Object.entries(etc)) {
    mkdirSync(join(root, "etc", path, ".."), { recursive: true });
    writeFileSync(join(root, "etc", path), content);
  }
  const text = script()
    .replace("PATH=/usr/sbin:/usr/bin:/sbin:/bin", `PATH='${bin}':/usr/bin:/bin`)
    .replaceAll("/etc/", `${root}/etc/`);
  const run = spawnSync("sh", ["-c", text, "system-update", ...args], { encoding: "utf8" });
  const result = { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim(), calls: readFileSync(calls, "utf8").trim().split("\n") };
  log("simulated run", result);
  return result;
};

// @req REL-UPD-07[badger-desktop,parrot] the root update helper takes no input and updates its own package only
describe("system-update helper (REL-UPD-07)", () => {
  it("is valid POSIX sh with its package name, path, PATH and locale fixed in the script", () => {
    for (const pkg of ["spacebadger", "spaceparrot"]) {
      const text = script(pkg);
      const check = spawnSync("sh", ["-n", "-c", text], { encoding: "utf8" });
      log(`${pkg} sh -n`, { status: check.status, stderr: check.stderr });
      expect(check.status, pkg).toBe(0);
      expect(text).toContain(`pkg='${pkg}'`);
      expect(text).toContain(`self='/usr/lib/${pkg}/system-update'`);
      expect(text).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
      expect(text).toContain("LC_ALL=C");
      // No positional parameter and no caller environment is ever read: only "$#" to refuse arguments. The two
      // message functions (`say`, `finish`) read their own arguments, which the script itself passes; single-quoted
      // text (the awk program's `$1` fields) is never expanded by the shell.
      const body = text
        .split("\n")
        .filter((line) => !/^(say|finish)\(\) \{/.test(line))
        .map((line) => line.replace(/'[^']*'/g, "''"))
        .join("\n");
      expect(body).not.toMatch(/\$\{?[1-9@*]/);
      expect(text).not.toMatch(/\$\{?(HOME|USER|DISPLAY|XDG_[A-Z_]+|LANG|PKEXEC_UID|SUDO_USER)\b/);
      // Never a whole-system upgrade (comments may name what is refused).
      const code = text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(code).not.toMatch(/-Syu|-Suy|\bdist-upgrade\b|apt-get (-[a-z]+ )*upgrade\b|dnf[^\n]*\bupgrade\s*>|\bzypper[^\n]*\bdup\b/);
      const shellcheck = spawnSync("shellcheck", ["-s", "sh", "-S", "warning", "-"], { input: text, encoding: "utf8" });
      if (shellcheck.error) log("shellcheck not installed, skipped");
      else {
        log(`${pkg} shellcheck`, { status: shellcheck.status, out: shellcheck.stdout });
        expect(shellcheck.status, shellcheck.stdout).toBe(0);
      }
    }
  });

  it("refuses names that could escape the script or the polkit file", () => {
    for (const bad of ["", "Spacebadger", "space badger", "x';reboot;'", "a/../b", "$(id)", "a".repeat(60)]) {
      expect(() => systemUpdateHelperLines(bad), bad).toThrow(/bad package name/);
      expect(() => systemUpdateHelperPath(bad), bad).toThrow(/bad package name/);
    }
    for (const bad of ["badger", "Bad<ger", "Badger & co", ""]) expect(() => systemUpdatePolicy("spacebadger", bad), bad).toThrow(/bad product name/);
  });

  it("refuses any argument before doing anything (exit 64)", () => {
    const run = simulate({}, {}, ["--anything"]);
    expect(run.status).toBe(SYSTEM_UPDATE_EXIT.usage);
    expect(run.stdout).toBe(`SF_SYSTEM_UPDATE=${SYSTEM_UPDATE_EXIT.usage}`);
    expect(run.calls).toEqual([""]);
  });

  it("refuses to run as a normal user (exit 77)", () => {
    const run = simulate({ id: "echo 1000" }, {});
    expect(run.status).toBe(SYSTEM_UPDATE_EXIT.notRoot);
  });

  it("stops when no package manager owns it (exit 69)", () => {
    const none = "exit 1";
    const run = simulate({ pacman: none, "dpkg-query": none, rpm: none }, {});
    expect(run.status).toBe(SYSTEM_UPDATE_EXIT.notManaged);
  });

  describe("pacman", () => {
    const pacman = (plan: string, installed: string[], after = "0.1.9-1") => `
      case "$1" in
        -Qqo) echo spacebadger ;;
        -Q) case "$2" in spacebadger) if grep -q -- '-S --needed --noconfirm' '__CALLS__'; then echo "spacebadger ${after}"; else echo 'spacebadger 0.1.5-1'; fi ;;
             ${installed.map((p) => `${p}) echo '${p} 1-1' ;;`).join(" ")}
             *) exit 1 ;; esac ;;
        -Sy) exit 0 ;;
        -Sp) printf '%s\\n' ${plan} ;;
        -S) exit 0 ;;
      esac`;
    const conf = { "pacman.conf": "[options]\n\n[spacefleet]\nSigLevel = Required DatabaseRequired\nServer = https://packages.spacefleet.io/arch/$arch\n" };
    const fakes = (body: string) => ({ "pacman-conf": "exit 1", "dpkg-query": "exit 1", rpm: "exit 1", pacman: body });

    it("refreshes SpaceFleet's list alone, then updates the one package (exit 0, never -Syu)", () => {
      const run = simulate(fakes(pacman("spacebadger", [])), conf);
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.updated);
      expect(run.stdout).toBe("SF_SYSTEM_UPDATE=0 before=0.1.5-1 after=0.1.9-1");
      const pacmanCalls = run.calls.filter((c) => c.startsWith("pacman ") && !c.startsWith("pacman -Q"));
      expect(pacmanCalls[0]).toMatch(/^pacman -Sy --config \S+\/pacman\.conf$/);
      expect(pacmanCalls.slice(1)).toEqual([
        "pacman -Sp --needed --print-format %n spacefleet/spacebadger",
        "pacman -S --needed --noconfirm spacefleet/spacebadger",
      ]);
      expect(run.calls.join("\n")).not.toMatch(/-Syu|-Su\b/);
    });

    it("refuses when the update would also upgrade another installed package (exit 12, nothing installed)", () => {
      const run = simulate(fakes(pacman("'spacebadger' 'glibc' 'newdep'", ["glibc"])), conf);
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.needsSystemUpdate);
      expect(run.stderr).toContain("would also upgrade: glibc");
      expect(run.stderr).not.toContain("newdep");
      expect(run.calls).not.toContain("pacman -S --needed --noconfirm spacefleet/spacebadger");
    });

    it("says so when the repository has nothing newer (exit 10)", () => {
      const run = simulate(fakes(pacman("", [], "0.1.5-1")), conf);
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.notNewer);
    });

    it("stops when [spacefleet] is not configured (exit 11)", () => {
      const run = simulate(fakes(pacman("spacebadger", [])), { "pacman.conf": "[options]\n" });
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.repoMissing);
      expect(run.calls.some((c) => c.startsWith("pacman -S"))).toBe(false);
    });
  });

  describe("APT", () => {
    const apt = (simulation: string) => ({
      pacman: "exit 1",
      "dpkg-query": `
        case "$1" in
          -S) echo "spacebadger: $2" ;;
          -W) if grep -q -- '-y -q --only-upgrade' '__CALLS__'; then printf 0.1.9; else printf 0.1.5; fi ;;
        esac`,
      "apt-get": `case "$*" in -s*) printf '%b' '${simulation}' ;; esac`,
    });
    const list = { "apt/sources.list.d/spacefleet.list": "deb [signed-by=/etc/apt/keyrings/spacefleet.gpg] https://packages.spacefleet.io/apt stable main\n" };

    it("refreshes SpaceFleet's source alone, then upgrades the one package (exit 0)", () => {
      const run = simulate(apt("Inst spacebadger [0.1.5] (0.1.9 SpaceFleet:stable [amd64])\\nInst libnew (1.0 Debian:stable [amd64])\\n"), list);
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.updated);
      const calls = run.calls.filter((c) => c.startsWith("apt-get"));
      expect(calls[0]).toBe("apt-get update -o Dir::Etc::sourcelist=sources.list.d/spacefleet.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0");
      expect(calls.slice(1)).toEqual([
        "apt-get -s install --only-upgrade spacebadger",
        "apt-get install -y -q --only-upgrade -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold spacebadger",
      ]);
    });

    it("refuses when the dry run upgrades another installed package (exit 12)", () => {
      const run = simulate(apt("Inst libc6 [2.36] (2.37 Debian:stable [amd64])\\nInst spacebadger [0.1.5] (0.1.9 SpaceFleet:stable [amd64])\\n"), list);
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.needsSystemUpdate);
      expect(run.stderr).toContain("would also upgrade: libc6");
      expect(run.calls.filter((c) => c.startsWith("apt-get install"))).toEqual([]);
    });

    it("stops when SpaceFleet's APT source is missing (exit 11)", () => {
      const run = simulate(apt(""), {});
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.repoMissing);
    });
  });

  describe("dnf", () => {
    it("upgrades the one package with SpaceFleet's repository alone enabled (exit 0)", () => {
      const run = simulate(
        {
          pacman: "exit 1",
          "dpkg-query": "exit 1",
          rpm: `case "$1" in -qf) printf spacebadger ;; -q) if grep -q '^dnf ' '__CALLS__'; then printf 0.1.9-1; else printf 0.1.5-1; fi ;; esac`,
          dnf: "exit 0",
        },
        { "yum.repos.d/spacefleet.repo": "[spacefleet]\n" },
      );
      expect(run.status).toBe(SYSTEM_UPDATE_EXIT.updated);
      expect(run.calls.filter((c) => c.startsWith("dnf"))).toEqual(["dnf -y --refresh --repo=spacefleet --setopt=spacefleet.skip_if_unavailable=False upgrade spacebadger"]);
    });
  });
});

// @req REL-UPD-07[badger-desktop,parrot] the password dialog names the app, asks every time, and allows only the helper
describe("polkit action (REL-UPD-07)", () => {
  it("names the app in 5 languages, needs an administrator password every time and points at the helper only", () => {
    const policy = systemUpdatePolicy("spacebadger", "Badger");
    log("policy", policy);
    expect(policy).toContain('<action id="io.spacefleet.spacebadger.update">');
    expect(policy).toContain('<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/spacebadger/system-update</annotate>');
    expect(policy).toContain("<description>Update Badger</description>");
    expect(policy).toContain('<description xml:lang="fr">Mettre à jour Badger</description>');
    for (const lang of ["fr", "nl", "de", "es"]) {
      expect(policy).toMatch(new RegExp(`<description xml:lang="${lang}">[^<]*Badger[^<]*</description>`));
      expect(policy).toMatch(new RegExp(`<message xml:lang="${lang}">[^<]*Badger[^<]*</message>`));
    }
    expect(policy.match(/<allow_(any|inactive|active)>auth_admin<\/allow_\1>/g)).toHaveLength(3);
    expect(policy).not.toContain("auth_admin_keep");
    expect(policy).not.toMatch(/>yes</);
    const xmllint = spawnSync("xmllint", ["--noout", "-"], { input: policy, encoding: "utf8" });
    if (xmllint.error) log("xmllint not installed, skipped");
    else expect(xmllint.status, xmllint.stderr).toBe(0);
    expect(systemUpdatePolicy("spaceparrot", "Parrot")).toContain("<description>Update Parrot</description>");
  });
});

// @req REL-UPD-07[badger-desktop,parrot] every .deb/.rpm/.pacman ships its helper (0755) and polkit action (0644)
describe("packaging (REL-UPD-07)", () => {
  it("writes the helper 0755 and the policy 0644 and maps them to their system paths", () => {
    const appDir = tmp();
    const args = systemUpdateFpmFiles({ appDir, packageName: "spacebadger", productName: "Badger" });
    log("fpm args", args);
    const [helper, policy] = args.map((arg) => arg.split("="));
    expect(helper[1]).toBe("/usr/lib/spacebadger/system-update");
    expect(policy[1]).toBe(`/usr/share/polkit-1/actions/${systemUpdateActionId("spacebadger")}.policy`);
    expect(statSync(helper[0]).mode & 0o7777).toBe(0o755);
    expect(statSync(policy[0]).mode & 0o7777).toBe(0o644);
    expect(readFileSync(helper[0], "utf8")).toBe(script());
  });

  // Each app's tests check that its .deb/.rpm/.pacman carry its own helper and policy (testing/linuxBuilderChecks.ts).
});
