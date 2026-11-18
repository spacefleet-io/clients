import { app } from "electron";

/**
 * A packaged app starts with NODE_ENV unset and the main bundle does not inline it, so the shared logger
 * (`packages/logger`: env label, debug level, pretty output) and everything the main process hands to the runtime
 * child would run in development mode in every shipped build. Side-effect module: it MUST be the first import of
 * the main entry so the logger module sees the value when it is created. An explicit NODE_ENV (the e2e harness
 * launches with `test`) and unpackaged runs (dev, from-source e2e) are left alone.
 */
if (app.isPackaged && !process.env.NODE_ENV?.trim()) process.env.NODE_ENV = "production";
