// Exposes the IPC bridge the renderer SDK needs. It sends nothing by itself:
// the bridge only forwards what a started renderer SDK hands it, and the main
// process ignores it until reporting is on.
import "@sentry/electron/preload";
