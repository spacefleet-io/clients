#!/usr/bin/env bash
# Render-cost run as a low-end home PC sees it (issue #25). The ultimate
# harness's `lowend` host profile (e2e-ultimate/lib/hostProfile.ts, the default)
# puts Electron and its children in a systemd scope: 4 physical cores, 200%
# quota over a 10 ms period, 8 GB, --disable-gpu (software compositing). The
# docker stack, Xvfb and the Playwright runner stay outside the scope.
#
#   SF_PERF_LABEL=before scripts/perf-nogpu.sh        # from apps/badger/desktop, after `bun run build`
#   SF_ULTIMATE_HOST_PROFILE=native ...               # no scope (GPU still disabled)
#   SF_ULTIMATE_CPUSET / SF_ULTIMATE_LOWEND_CPU_QUOTA_PCT / SF_ULTIMATE_LOWEND_MEMORY_MAX
set -euo pipefail
cd "$(dirname "$0")/.."
export SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION=1
exec ../../../scripts/run-headless.sh bunx playwright test -c playwright.perf.config.ts
