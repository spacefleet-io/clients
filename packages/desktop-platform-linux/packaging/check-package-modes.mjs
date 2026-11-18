#!/usr/bin/env node
// REL-DIST-13 release guard: `node check-package-modes.mjs <pkg>...` lists every file of each .deb/.rpm/.pacman that
// is group- or world-writable or setuid/setgid, and exits 1 if there is any (the release then publishes nothing).
// Needs bsdtar (.deb, .pacman) and rpm (.rpm), the same host tools the packaging step installs.
import { packageModeViolations } from "./file-modes.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: check-package-modes.mjs <package.deb|.rpm|.pacman>...");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const violations = packageModeViolations(file);
  if (violations.length === 0) {
    console.log(`[package-modes] ok ${file}`);
    continue;
  }
  failed += 1;
  console.error(`[package-modes] FAIL ${file}: ${violations.length} entries other users could modify or that run as root`);
  for (const { mode, path, reason } of violations) console.error(`  ${mode} ${path} (${reason})`);
}
if (failed > 0) {
  console.error(`[package-modes] ${failed} of ${files.length} packages fail REL-DIST-13; fix the build (umask 022, u=rwX,go=rX), do not publish`);
  process.exit(1);
}
