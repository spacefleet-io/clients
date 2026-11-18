/**
 * REL-UPD-04 / REL-DIST-11: in the Flatpak, start at login goes through the Background portal (the sandbox cannot
 * write the host's autostart entry). The request builder and the call are the real code; only `execFile` is a
 * recorder. The same arguments were run by hand inside a sandbox on KDE Plasma (see REL-DIST-11 notes).
 */
import { describe, expect, it } from "vitest";
import { flatpakBackgroundRequestArgs, requestFlatpakAutostart } from "../src/main/flatpakAutostart";

const SUITE = "[parrot-flatpak-autostart]";

const run = (on: boolean, answer: { error?: Error; stdout?: string; stderr?: string }) => {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const logs: string[] = [];
  const failures: string[] = [];
  requestFlatpakAutostart(on, {
    log: (line) => logs.push(line),
    fail: (line) => failures.push(line),
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, timeout: options.timeout });
      callback(answer.error ?? null, answer.stdout ?? "", answer.stderr ?? "");
    },
  });
  console.info(`${SUITE} on=${on} calls=${JSON.stringify(calls)} logs=${JSON.stringify(logs)} failures=${JSON.stringify(failures)}`);
  return { calls, logs, failures };
};

describe("@req REL-UPD-04[parrot] @req REL-DIST-11[parrot] start at login in the Flatpak", () => {
  it("asks the Background portal for autostart with the Flatpak command and --hidden", () => {
    const { calls, logs, failures } = run(true, { stdout: "(objectpath '/org/freedesktop/portal/desktop/request/1_42/t',)\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("gdbus");
    expect(calls[0]!.args.slice(0, 9)).toEqual([
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.Background.RequestBackground",
      "",
    ]);
    expect(calls[0]!.args[9]).toContain("'autostart': <true>");
    expect(calls[0]!.args[9]).toContain("'commandline': <['parrot', '--hidden']>");
    expect(logs[0]).toContain("start at login=true asked of the background portal");
    expect(failures).toEqual([]);
  });

  it("turning it off asks the portal to remove the entry", () => {
    expect(flatpakBackgroundRequestArgs(false)[9]).toContain("'autostart': <false>");
    expect(run(false, { stdout: "(objectpath '/x',)" }).calls[0]!.args[9]).toContain("'autostart': <false>");
  });

  it("a refused or missing portal is logged and setup goes on", () => {
    const { failures, logs } = run(true, { error: new Error("exit 1"), stderr: "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown\n" });
    expect(logs).toEqual([]);
    expect(failures).toEqual(["[login-item] background portal refused start at login=true: Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"]);
  });
});
