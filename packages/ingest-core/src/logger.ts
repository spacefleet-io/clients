import { childLogger, createLogger } from "@space/logger";

export const logger = createLogger({
  service: "ingest-core",
});

export const scopeLogger = (scope: string) => childLogger(logger, { scope });
