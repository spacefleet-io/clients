# `@space/runtime-client`

Shared client helpers for local `@space/runtime` interactions.

Current scope:
- Runtime session helpers (`@space/runtime-client/session`)
- Shared runtime jobs helpers (`@space/runtime-client/jobs`):
  - `listRuntimeJobs(...)`
  - `getRuntimeJob(...)`
  - `cancelRuntimeJob(...)`
  - `retryRuntimeJob(...)`
  - `createRuntimeJobsStream(...)` (canonical `runtime.jobs` WS channel with direct delta application for known jobs, reconnect replay via `lastEventId`, and polling only while disconnected)

Development:
- `bun run --cwd packages/runtime-client test`
