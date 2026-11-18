import { childLogger, createLogger } from "@space/logger";

export const logger = createLogger({
  service: "desktop-main",
  pretty: process.env.NODE_ENV !== "production",
});

export const scopeLogger = (scope: string) => childLogger(logger, { scope });
