# @space/logger

Shared structured logger for monorepo apps using `pino` with optional `pino-pretty` output.

## Usage

```ts
import { createLogger, childLogger } from "@space/logger";

const logger = createLogger({ service: "storage-gateway" });
const tunnelLogger = childLogger(logger, { scope: "storage_tunnel" });

tunnelLogger.info({ event: "open", sessionId: "abc" });
```

## Env controls

- `SF_LOG_LEVEL` (fallback `LOG_LEVEL`, default `info`)
- `SF_LOG_PRETTY` (fallback `LOG_PRETTY`): `1/true/on/yes` to enable pretty output

By default, pretty output is enabled outside production.

## Redaction defaults

The logger removes common sensitive fields by default:
- `token`, `*.token`
- `authorization`, `*.authorization`
- `password`, `*.password`
- `secret`, `*.secret`
- `keyBase64`, `*.keyBase64`
