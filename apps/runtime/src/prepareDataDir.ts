/**
 * Side-effect module, imported FIRST by `index.ts`: ES modules evaluate in
 * import order, and `./runtime` loads the key/job/event stores from the data
 * dir as it is imported. Preparing the dir here, before that, creates it
 * owner-only and lets the platform carry a previous default location's data
 * over (Linux: the old tmpfs `/tmp/spacefleet-runtime`) before any store reads
 * an empty dir and later overwrites the migrated files.
 *
 * The guardian prepares the dir too before spawning; this covers a runtime
 * started on its own. Skipped under vitest, which must not touch the real
 * default dir.
 */
import { getDesktopPlatform } from "@space/desktop-platform";

if (!process.env.VITEST) getDesktopPlatform().paths.prepareRuntimeDataDir({ env: process.env });
