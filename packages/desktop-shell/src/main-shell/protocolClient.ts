/**
 * Arguments for `app.setAsDefaultProtocolClient` of an app's link scheme (`badger:`, `parrot:`). A packaged app
 * registers itself. A dev run (`process.defaultApp`: `electron <main.js>`) must register the Electron binary plus the
 * absolute path of its main script, else the OS would start a bare Electron; when the dev run's `argv[1]` is itself a
 * link (the OS started it with one), there is no script to register and the app registers itself.
 *
 * Pure (no Electron import) so the decision is unit-tested.
 */
export const protocolClientArgs = (
  scheme: string,
  input: {
    defaultApp: boolean;
    execPath: string;
    argv: readonly string[];
    resolvePath: (path: string) => string;
  },
): [scheme: string] | [scheme: string, path: string, args: string[]] => {
  const script = input.argv[1];
  const isLink = typeof script === "string" && script.trim().toLowerCase().startsWith(`${scheme}:`);
  if (input.defaultApp && typeof script === "string" && script.length > 0 && !isLink) {
    return [scheme, input.execPath, [input.resolvePath(script)]];
  }
  return [scheme];
};
