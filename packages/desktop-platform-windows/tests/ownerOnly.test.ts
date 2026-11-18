import { describe, expect, it } from "vitest";
import { buildIcaclsArgs, parseWhoamiSid, restrictFileToOwnerWindows, type AclRun } from "../src/ownerOnly";
import { windowsPaths } from "../src/paths";
import { decodePowerShellScript } from "../src/powershell";

const SID = "S-1-5-21-1004336348-1177238915-682003330-1000";

describe("windows owner-only files", () => {
  it("reads the SID from whoami csv output", () => {
    console.info("[windows-owner-only:parse] checking whoami parsing");
    expect(parseWhoamiSid(`"DESKTOP-ABC\\ada","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiSid("")).toBeNull();
    expect(parseWhoamiSid('"DESKTOP-ABC\\ada","not-a-sid"')).toBeNull();
  });

  it("drops inheritance and grants the SID alone", () => {
    expect(buildIcaclsArgs("C:\\d\\owner.secret", SID)).toEqual(["C:\\d\\owner.secret", "/inheritance:r", "/grant:r", `*${SID}:F`]);
  });

  it("runs whoami then icacls from System32", () => {
    const calls: Array<[string, string[]]> = [];
    const run: AclRun = (command, args) => {
      calls.push([command, args]);
      return command.endsWith("whoami.exe") ? { status: 0, stdout: `"PC\\ada","${SID}"\r\n`, stderr: "" } : { status: 0, stdout: "", stderr: "" };
    };
    restrictFileToOwnerWindows("C:\\d\\owner.secret", { SystemRoot: "C:\\Windows" }, run);
    console.info("[windows-owner-only:calls]", calls);
    expect(calls).toEqual([
      ["C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"]],
      ["C:\\Windows\\System32\\icacls.exe", ["C:\\d\\owner.secret", "/inheritance:r", "/grant:r", `*${SID}:F`]],
    ]);
  });

  it("throws when the SID cannot be read or icacls fails", () => {
    const whoamiFails: AclRun = () => ({ status: 1, stdout: "", stderr: "boom" });
    expect(() => restrictFileToOwnerWindows("C:\\f", {}, whoamiFails)).toThrow(/SID.*boom/);
    const icaclsFails: AclRun = (command) =>
      command.endsWith("whoami.exe") ? { status: 0, stdout: `"PC\\ada","${SID}"`, stderr: "" } : { status: 5, stdout: "", stderr: "Access is denied." };
    expect(() => restrictFileToOwnerWindows("C:\\f", {}, icaclsFails)).toThrow(/icacls failed \(Access is denied\./);
  });

  it("@bugfix @regression-proof reads the SID from the process token when whoami fails (exit 66, nothing on stderr)", () => {
    // A Windows laptop, 2026-11-16 00:55:26Z, Badger 0.1.5: whoami.exe exited 66 with an empty stderr as the PC went to sleep, so the
    // runtime refused to start ("could not read the current user's SID (exit 66)").
    const calls: Array<[string, string[]]> = [];
    const run: AclRun = (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("whoami.exe")) return { status: 66, stdout: "", stderr: "" };
      if (command.endsWith("powershell.exe")) return { status: 0, stdout: `\uFEFF${SID}\r\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    restrictFileToOwnerWindows("C:\\d\\owner.secret", { SystemRoot: "C:\\Windows" }, run);
    console.info("[windows-owner-only:fallback]", calls.map(([command]) => command));
    expect(calls.map(([command]) => command)).toEqual([
      "C:\\Windows\\System32\\whoami.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\icacls.exe",
    ]);
    expect(decodePowerShellScript(calls[1]![1])).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    expect(calls[2]![1]).toEqual(["C:\\d\\owner.secret", "/inheritance:r", "/grant:r", `*${SID}:F`]);
  });

  it("@bugfix names both failures when neither whoami nor the token read gives a SID", () => {
    const run: AclRun = (command) =>
      command.endsWith("whoami.exe") ? { status: 66, stdout: "Erreur : accès réseau", stderr: "" } : { status: 1, stdout: "", stderr: "no token" };
    expect(() => restrictFileToOwnerWindows("C:\\f", { SystemRoot: "C:\\Windows" }, run)).toThrow(
      /could not read the current user's SID \(whoami: exit 66, Erreur : accès réseau; powershell: no token\)/,
    );
  });

  it("the path layer exposes the file restriction and a no-op dir restriction", () => {
    expect(typeof windowsPaths.restrictFileToOwner).toBe("function");
    expect(() => windowsPaths.restrictDirToOwner("C:\\nope")).not.toThrow();
  });
});
