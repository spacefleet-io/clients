import { scrubErrorEvent } from "./scrub";

/** The SpaceFleet app a report comes from; with the platform, it says which build broke. */
export type ReportApp = "badger" | "parrot";
export type ReportPlatform = "desktop" | "web" | "phone" | "tv";

/** What an app knows about itself when it starts reporting. */
export interface ReporterConfig {
  /** Bugsink DSN baked in at build time; empty when this build cannot report. */
  dsn: string;
  /** App version, for example the `package.json` version. */
  release: string;
  environment?: string;
  /** Sent as the `app` and `platform` tags of every report (REL-LOG-06). */
  app?: ReportApp;
  platform?: ReportPlatform;
}

/** The `app`/`platform` tags of a config, or undefined when it names neither. */
export function reportTags(config: Pick<ReporterConfig, "app" | "platform">): Record<string, string> | undefined {
  const tags: Record<string, string> = {};
  if (config.app) tags.app = config.app;
  if (config.platform) tags.platform = config.platform;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

interface NamedIntegration {
  name: string;
}

/**
 * Options every SpaceFleet SDK instance starts with. They only restate what the
 * scrubber enforces anyway: no personal data, no breadcrumbs, no performance
 * data, no sessions.
 */
export function createReporterOptions(config: ReporterConfig) {
  const tags = reportTags(config);
  return {
    dsn: config.dsn,
    release: config.release,
    environment: config.environment ?? "production",
    ...(tags ? { initialScope: { tags } } : {}),
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    attachStacktrace: true,
    sendClientReports: false,
    enableLogs: false,
    beforeSend: scrubErrorEvent,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: () => null,
  };
}

/**
 * Keeps only the default integrations named in `allowed`. The SDKs install
 * integrations that add breadcrumbs, screenshots, native memory dumps, source
 * lines or local variables; none may run, so each adapter names what it keeps.
 */
export function keepIntegrations<T extends NamedIntegration>(allowed: ReadonlySet<string>): (defaults: T[]) => T[] {
  return (defaults) => defaults.filter((integration) => allowed.has(integration.name));
}

/**
 * Accepts a build-time DSN only when it is an https address with a public key
 * and a project id (`https://<key>@host/<id>`); anything else means "this
 * build cannot report".
 */
export function resolveDsn(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.username || !/^\/(?:[^/]+\/)*\d+$/.test(url.pathname)) return null;
    return value;
  } catch {
    return null;
  }
}
