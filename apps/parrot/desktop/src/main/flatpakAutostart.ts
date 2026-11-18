/**
 * Start at login inside the Flatpak (UX-SETUP-06 step 5, REL-UPD-04, REL-DIST-11). The sandbox cannot write the
 * host's `~/.config/autostart` and its `/app/...` path means nothing outside it, so Parrot asks the Background portal,
 * which writes (or removes) the host's autostart entry for `io.spacefleet.Parrot` itself. Every sandbox may call the
 * portal; no extra permission. The runtime ships `gdbus`, so no D-Bus library is bundled for this one call.
 */
import { execFile } from "node:child_process";

/** The `gdbus` arguments of `org.freedesktop.portal.Background.RequestBackground` for start at login on or off. */
export const flatpakBackgroundRequestArgs = (on: boolean): string[] => [
  "call",
  "--session",
  "--dest",
  "org.freedesktop.portal.Desktop",
  "--object-path",
  "/org/freedesktop/portal/desktop",
  "--method",
  "org.freedesktop.portal.Background.RequestBackground",
  "",
  // `parrot` is the Flatpak's command (packaging/flatpak/io.spacefleet.Parrot/io.spacefleet.Parrot.yml); the portal
  // runs it as `flatpak run --command=parrot io.spacefleet.Parrot --hidden`.
  `{'reason': <'Start Parrot when you log in'>, 'autostart': <${on}>, 'commandline': <['parrot', '--hidden']>, 'dbus-activatable': <false>}`,
];

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/** Asks the portal; the answer (a request handle, or the error) is only logged: setup never waits on it. */
export const requestFlatpakAutostart = (
  on: boolean,
  deps: { log: (line: string) => void; fail: (line: string) => void; execFile?: ExecFile },
): void => {
  const run = deps.execFile ?? (execFile as unknown as ExecFile);
  run("gdbus", flatpakBackgroundRequestArgs(on), { timeout: 10_000 }, (error, stdout, stderr) => {
    if (error) {
      deps.fail(`[login-item] background portal refused start at login=${on}: ${(stderr || error.message).trim()}`);
      return;
    }
    deps.log(`[login-item] start at login=${on} asked of the background portal ${stdout.trim()}`);
  });
};
