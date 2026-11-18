/**
 * What the played media's silo (one gateway = one link) tells this viewer while it is saturated (STOR-BW-07, STOR-BW-08,
 * PLAY-QUAL-07). The native playback proxy opens the tunnel session itself, so it is the one that hears the gateway: it
 * forwards every 503 `free_playback_refused`, every 503 `playback_stopped` and the traffic of every session response and
 * `session.ack` as a `SpacePlaybackTraffic` event (`PlaybackBridge.onTraffic`), parsed here. `GET /storage/traffic` is only
 * the fallback, read when no native report arrived for a while (or to explain a failure the proxy could not).
 */
import { qualityRank, capTarget, type CapTarget, type QualityCap, type Variant } from "@space/playback-abr";
import {
  STORAGE_FREE_PLAYBACK_REFUSED_CODE,
  STORAGE_PLAYBACK_STOPPED_CODE,
  parseStorageTraffic,
  type StorageTraffic,
} from "@space/shared/storageTunnel";

const APP_ID = "badger";
const ATTEMPT_TIMEOUT_MS = 3_000;

/** The fallback poll of the silo's report: only when the native proxy reported nothing for this long. */
export const TRAFFIC_POLL_MS = 60_000;

/** True when the fallback poll should run: no native report was heard (null) or the last one is older than the poll interval. */
export const trafficPollDue = (lastNativeReportAt: number | null, now: number): boolean =>
  lastNativeReportAt === null || now - lastNativeReportAt >= TRAFFIC_POLL_MS;

/**
 * The silo's report for this account, from the first reachable gateway address; null when none answered. The poll is
 * about playback, so it names the playing profile (STOR-BW-11).
 */
export const fetchSiloTraffic = async (
  gatewayBaseUrls: readonly string[],
  token: string,
  profileId: string,
): Promise<StorageTraffic | null> => {
  for (const base of gatewayBaseUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/storage/traffic?profileId=${encodeURIComponent(profileId)}`, {
        headers: { Authorization: `Bearer ${token}`, "x-space-app": APP_ID },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      const traffic = parseStorageTraffic(body && typeof body === "object" && "traffic" in body ? body.traffic : null);
      if (traffic) return traffic;
    } catch {
      // Unreachable address: try the next one.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/** The suffix of the `player.error.<code>` i18n key for a failure the silo explains. */
export type SiloUnavailableCode = "playbackStopped" | "freePlaybackRefused";

/** What the native proxy heard from the gateway (`SpacePlaybackTraffic`), reduced to what the player acts on. */
export type SiloTrafficEvent =
  /** 503 `free_playback_refused` on a new tunnel session (STOR-BW-07). */
  | { kind: "refused"; traffic: StorageTraffic | null }
  /** 503 `playback_stopped` on a download (STOR-BW-08). */
  | { kind: "stopped"; traffic: StorageTraffic | null }
  /** The `traffic` of a session response or a `session.ack`. */
  | { kind: "report"; traffic: StorageTraffic };

/**
 * Reads one native event: the JSON string (Android) or dictionary (iOS) `{ source, status, code, traffic }` the proxy forwards
 * from the gateway's answer as is (`code` = the body's `error`). Null for anything that says nothing about traffic.
 */
export const parseSiloTrafficEvent = (raw: unknown): SiloTrafficEvent | null => {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const status = "status" in value && typeof value.status === "number" ? value.status : 200;
  const code = "code" in value && typeof value.code === "string" ? value.code : null;
  const traffic = parseStorageTraffic("traffic" in value ? value.traffic : null);
  if (status === 503 && code === STORAGE_FREE_PLAYBACK_REFUSED_CODE) return { kind: "refused", traffic };
  if (status === 503 && code === STORAGE_PLAYBACK_STOPPED_CODE) return { kind: "stopped", traffic };
  if (status >= 200 && status < 300 && traffic) return { kind: "report", traffic };
  return null;
};

/**
 * The silo's report after an event, and the failure it explains (null = none). A refusal or a stop is what the gateway said, not an
 * inference; a report names a stop only when it says this viewer was stopped. A refusal or a stop without a readable report keeps
 * the previous one. The 503 `playback_stopped` reports the silo without the plan's cap, so a stop keeps the cap it had: a stop is
 * never the cap lifting.
 */
export const applySiloTrafficEvent = (
  previous: StorageTraffic | null,
  event: SiloTrafficEvent,
): { traffic: StorageTraffic | null; unavailable: SiloUnavailableCode | null } => {
  if (event.kind === "refused") return { traffic: event.traffic ?? previous, unavailable: "freePlaybackRefused" };
  if (event.kind === "stopped") {
    const traffic = event.traffic ?? previous;
    return {
      traffic: traffic ? { ...traffic, qualityCap: traffic.qualityCap ?? previous?.qualityCap ?? null, playbackStopped: true } : null,
      unavailable: "playbackStopped",
    };
  }
  return { traffic: event.traffic, unavailable: event.traffic.playbackStopped ? "playbackStopped" : null };
};

/** The quality cap that applies now: only while the silo is saturated. */
export const activeQualityCap = (traffic: StorageTraffic | null): QualityCap | null => (traffic?.saturated ? traffic.qualityCap : null);

export type CapStep = {
  /** Switch to a rung at or under the cap, stop (a free viewer with no rung at or under 480p), or nothing to do. */
  target: CapTarget | null;
  /** Playback is (or is about to be) held to the cap: the "too much traffic" notice applies. */
  limited: boolean;
};

export const planCapStep = (variants: readonly Variant[], currentId: string, cap: QualityCap): CapStep => {
  const target = capTarget(variants, currentId, cap);
  const current = variants.find((variant) => variant.id === currentId);
  const atCap = current !== undefined && qualityRank(current.quality) >= qualityRank(cap);
  return { target, limited: target?.kind === "switch" || atCap };
};

/** The rung a cap took the player off, and the one it put it on: kept so a pinned rung can come back when the cap lifts. */
export type CapDisplacement = { displacedId: string; capTargetId: string };

/** Remembers a cap switch; a second step under a cap that still applies keeps the rung the viewer was first taken off. */
export const noteCapSwitch = (previous: CapDisplacement | null, fromId: string, toId: string): CapDisplacement => ({
  displacedId: previous?.displacedId ?? fromId,
  capTargetId: toId,
});

/**
 * The cap is gone (`cap` null): Auto climbs back by itself (its ceiling is the Settings quality again), so only a pinned rung the
 * cap displaced needs putting back, and only while the player is still on the rung the cap chose (a pick made since wins).
 * While a cap still applies, or while the player is stopped or failed (`failed`; Retry starts over), nothing changes.
 * `displaced` is the record to keep.
 */
export const planCapRelease = (
  variants: readonly Variant[],
  quality: { mode: "auto" | "manual"; currentId: string | null },
  displacement: CapDisplacement | null,
  cap: QualityCap | null,
  failed: boolean,
): { restoreTo: string | null; displaced: CapDisplacement | null } => {
  if (cap !== null || failed || displacement === null) return { restoreTo: null, displaced: displacement };
  const restorable =
    quality.mode === "manual" &&
    quality.currentId === displacement.capTargetId &&
    variants.some((variant) => variant.id === displacement.displacedId);
  return { restoreTo: restorable ? displacement.displacedId : null, displaced: null };
};
