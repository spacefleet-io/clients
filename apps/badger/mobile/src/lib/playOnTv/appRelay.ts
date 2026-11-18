/**
 * The apps' "Play on TV" channel (UX-TV-02): the HTTP relay transport on the configured API with react-native-sse for the
 * stream, sealed with the account key through react-native-quick-crypto. Used by the TV's receiver and the phone's remote.
 */
import EventSource from "react-native-sse";
import crypto from "react-native-quick-crypto";
import { getApiBaseUrl } from "@space/shared/api";
import { getStoredLibraryKey } from "../onboarding";
import {
  createHttpRelayTransport,
  createPlayOnTvChannel,
  newPeerId,
  type EventSourceLike,
  type PeerKind,
  type PlayOnTvChannel,
  type RelayTransport,
} from "./channel";
import { createRemoteSealer, type SealCrypto } from "./seal";

export type AppRelay = { transport: RelayTransport; channel: PlayOnTvChannel };

const castLog = (scope: string) => (event: string, data: Record<string, unknown> = {}) =>
  console.info(`tv.cast.${scope}.${event}`, JSON.stringify(data));

/** Null when the device holds no account key yet (nothing could be sealed). */
export const createAppRelay = async (kind: PeerKind, getToken: () => string | null): Promise<AppRelay | null> => {
  const key = await getStoredLibraryKey().catch(() => null);
  if (!key) {
    console.warn("tv.cast.relay.no_key", JSON.stringify({ kind }));
    return null;
  }
  // quick-crypto mirrors node's crypto API; its typings differ only in Buffer generics.
  const sealCrypto = crypto as unknown as SealCrypto;
  const transport = createHttpRelayTransport({
    peerId: newPeerId(kind),
    getApiBaseUrl,
    getToken,
    fetch: (url, init) => fetch(url, init),
    openEventSource: (url, headers) => {
      const es = new EventSource(url, { headers, lineEndingCharacter: "\n", pollingInterval: 2_000 });
      // react-native-sse types its events per generic; the transport only needs addEventListener / close.
      return es as unknown as EventSourceLike;
    },
    log: castLog(`${kind}.relay`),
  });
  const channel = createPlayOnTvChannel({ transport, sealer: createRemoteSealer(sealCrypto, key), log: castLog(`${kind}.channel`) });
  return { transport, channel };
};
