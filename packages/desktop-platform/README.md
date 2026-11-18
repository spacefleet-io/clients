# @space/desktop-platform

`getDesktopPlatform()` returns the `DesktopPlatform` of the running OS. This
package and `@space/desktop-platform-*` are the only places allowed to read
`process.platform`.

`bun src/conformance-cli.ts [--only id,id] [--json] [--expect-ok N] [--helper <path>]` runs the
conformance suite on the current OS and prints TAP (the command used in the Windows VM and on the
macOS runner). `--expect-ok N` exits 1 when fewer than N checks are `ok` (exit 2 when N is not a
number): the Windows quick test passes 19. `--helper <path>` points the child-lifetime checks at a
bundled `helper-platform.js`, for the `bun build --compile` binary the quick test runs on Windows
(a compiled binary spawns itself with `BUN_BE_BUN=1`, which the CLI sets, and cannot read the helper
out of its virtual filesystem).

`@space/desktop-platform/secret-file` (main process): `createSecretFile` keeps one secret in an
owner-only file sealed with Electron's async `safeStorage` (plain 0600 with a logged warning where the
system has no protected storage; files only the legacy sync `decryptString` opens are re-sealed).
Each app keeps its on-disk layout: `taggedSecretFormat` (Parrot), `envelopeSecretFormat` (Badger
`session.json`).
