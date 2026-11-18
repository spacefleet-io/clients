/**
 * Prepares one cast (UX-TV-03): plans what the device can play, refuses before anything is served, starts the LAN server
 * behind a fresh one-time token and puts the chosen subtitle in WebVTT. The native server is injected (`CastServerApi`,
 * the `CastServer` bridge in production) so the decisions and the order of the steps are unit-tested.
 */
import type { StartProxyConfig, CastServerInfo } from "@space/mobile-mpv-playback";
import type { IngestMetadata } from "@space/mobile-mpv-playback";
import { planCast, type CastPlan, type CastRefusalReason, type CastStartTracks } from "./castPlan";
import type { CastProfile } from "./castProfiles";
import type { CastTokenIssuer } from "./castToken";
import { strictWebVtt } from "@space/shared/subtitleVtt";

/** The part of the native `CastServer` bridge the flow uses. */
export type CastServerApi = {
  start: (args: { metadataJson: string; libraryKeyBase64: string; config: StartProxyConfig; token: string; startSeconds?: number }) => Promise<CastServerInfo>;
  readText: (key: string) => Promise<string>;
  putText: (key: string, body: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
};

/** Where a cast goes: a Google Cast device found by discovery, or the AirPlay route the user picked in the system button. */
export type CastTarget =
  | { kind: "google-cast"; deviceId: string; name: string; modelName: string }
  | { kind: "airplay"; name: string };

/** What the player session loads for a file: the ingest metadata, the library key and how the server reaches the objects. */
export type CastSource = {
  metadata: IngestMetadata;
  libraryKeyBase64: string;
  proxyConfig: StartProxyConfig;
};

/** Why the cast could not start for a reason that is not the title's: the suffix of the `cast.error.<code>` i18n key. */
export type CastErrorCode = "noWifi" | "serverFailed";

export type PrepareCastResult =
  | {
      ok: true;
      masterUrl: string;
      plan: Extract<CastPlan, { ok: true }>;
      host: string;
      /** The WebVTT of the chosen subtitle, served under the token (`/playback/object/<key>`); null when none is cast. */
      subtitleUrl: string | null;
    }
  | { ok: false; reason: CastRefusalReason; detail: string }
  | { ok: false; reason: "error"; code: CastErrorCode; detail: string };

/** The i18n code of a native error: the Wi-Fi case is told apart (the user can fix it), everything else is "server failed". */
export const castErrorCode = (err: unknown): CastErrorCode => {
  const message = err instanceof Error ? err.message : err && typeof err === "object" && "message" in err ? err.message : err;
  return String(message).includes("cast_no_wifi") ? "noWifi" : "serverFailed";
};

const EMPTY_VTT = "WEBVTT\n";

export const prepareCast = async (input: {
  source: CastSource;
  profile: CastProfile;
  startTracks: CastStartTracks;
  server: CastServerApi;
  issuer: CastTokenIssuer;
  /**
   * Called once the device is known to accept the title, before the server starts: the caller starts the device's session
   * here so the receiver launches while the server starts and the subtitle is converted (cast-start latency, UX-TV-03).
   */
  onPlanned?: () => void;
  /** Where the device will start playing (a resume point): the server warms the first segments from there. */
  startSeconds?: number;
}): Promise<PrepareCastResult> => {
  const { source, profile, startTracks, server, issuer, onPlanned, startSeconds } = input;
  const plan = planCast({ metadata: source.metadata, startTracks, profile });
  if (!plan.ok) {
    console.info("[cast.flow] refused", JSON.stringify({ reason: plan.reason, detail: plan.detail }));
    return plan;
  }
  onPlanned?.();
  const token = issuer.issue();
  let info: CastServerInfo;
  try {
    info = await server.start({
      metadataJson: JSON.stringify(plan.serverMetadata),
      libraryKeyBase64: source.libraryKeyBase64,
      config: source.proxyConfig,
      token,
      startSeconds,
    });
  } catch (err) {
    // A server that half started must not stay on the LAN with a token nobody holds.
    issuer.revoke();
    await server.stop().catch(() => undefined);
    const code = castErrorCode(err);
    console.warn("[cast.flow] server start failed", JSON.stringify({ code, error: String(err) }));
    return { ok: false, reason: "error", code, detail: String(err) };
  }
  console.info("[cast.flow] server up", JSON.stringify({ host: info.host, port: info.port, subtitle: plan.subtitle?.id ?? null }));

  let subtitleUrl: string | null = null;
  if (plan.subtitle) {
    // The device's subtitle parser is stricter than mpv's: always hand it cleaned-up WebVTT. If the file cannot be read the
    // film still plays, without subtitles (an empty WebVTT), rather than failing the whole cast.
    let vtt = EMPTY_VTT;
    try {
      vtt = strictWebVtt(await server.readText(plan.subtitle.url), { hlsTimestampMap: true });
    } catch (err) {
      console.warn("[cast.flow] subtitle unreadable, serving an empty track", JSON.stringify({ track: plan.subtitle.id, error: String(err) }));
    }
    await server.putText(plan.subtitle.url, vtt);
    subtitleUrl = `${info.baseUrl}/playback/object/${encodeURIComponent(plan.subtitle.url)}`;
  }

  return { ok: true, masterUrl: info.masterUrl, plan, host: info.host, subtitleUrl };
};
