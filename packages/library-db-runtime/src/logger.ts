import { childLogger, createLogger } from "@space/logger";

export const logger = createLogger({
  service: "library-db-runtime",
});

export const scopeLogger = (scope: string) => childLogger(logger, { scope });
