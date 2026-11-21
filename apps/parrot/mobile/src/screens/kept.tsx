// "Save offline" on the screens (PAR-OFFL-01/02), as on the desktop (packages/ui/src/parrot/offline.tsx): the
// keep button on an album or a playlist (a download arrow while not kept, a turning circle while its songs download, a
// green tick once they are all here), and the line under a kept one ("Kept on this phone · 340 MB" or "Downloading 3
// of 12"). The song sheet's keep row and the copy question live with the other sheets (../state/playlistEditor).
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Animated, Easing, Text } from "react-native";
import { ArrowDownToLine, CircleCheck, LoaderCircle } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { formatLocalizedStorage } from "@space/shared/format";
import { offlineReach, type KeptKind, type KeptStatus, type OfflineReach } from "@space/parrot-core";
import { useDeviceOnline } from "@space/mobile-media-proxy/downloads";
import { getKeptStatus, subscribeKept } from "../lib/kept";
import { listSongs } from "../lib/library";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { colors } from "../theme";
import { IconButton } from "./ui";

export type KeepState = "off" | "downloading" | "kept";

export type KeptView = {
  status: KeptStatus;
  /** The kept item itself (not a song a kept album or playlist holds). */
  entry: (kind: KeptKind, id: string) => KeptStatus["entries"][number] | undefined;
  state: (kind: KeptKind, id: string) => KeepState;
  /** Whether a song is on the kept list (on its own or through an album or playlist). */
  holdsSong: (trackId: string) => boolean;
};

/** What is kept on this phone, fresh on every change (a song finishing its download included). */
export const useKept = (): KeptView => {
  const status = useSyncExternalStore(subscribeKept, getKeptStatus);
  return useMemo(() => {
    const songs = new Map(status.songs.map((song) => [song.trackId, song.onDevice]));
    const entry = (kind: KeptKind, id: string) => status.entries.find((candidate) => candidate.kind === kind && candidate.id === id);
    return {
      status,
      entry,
      state: (kind, id) => {
        const kept = entry(kind, id);
        if (kept) return kept.done < kept.total ? "downloading" : "kept";
        // A song a kept album or playlist holds shows where it is (PAR-OFFL-01).
        if (kind === "song" && songs.has(id)) return songs.get(id) ? "kept" : "downloading";
        return "off";
      },
      holdsSong: (trackId) => songs.has(trackId),
    };
  }, [status]);
};

/**
 * While the phone is offline, what still plays (PAR-OFFL-04): the songs kept on it, and the albums, artists and
 * playlists holding one. Null while online, when everything plays. Screens grey out and disable the rest.
 */
export const useOfflineReach = (): OfflineReach | null => {
  const online = useDeviceOnline();
  const { status } = useKept();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const songs = useQuery(() => (online ? Promise.resolve(null) : listSongs()), [online, version]);
  return useMemo(() => {
    if (online) return null;
    const onDevice = new Set(status.songs.filter((song) => song.onDevice).map((song) => song.trackId));
    return offlineReach(onDevice, songs.data ?? []);
  }, [online, status, songs.data]);
};

const Spinning = ({ size, color }: { size?: number; color?: string }) => {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} />
    </Animated.View>
  );
};

/** The keep toggle of an album or a playlist header; pressing it keeps the item or turns keeping off. */
export const KeepButton = ({ state, onPress, testID = "keep-toggle" }: { state: KeepState; onPress: () => void; testID?: string }) => {
  const { t } = useTranslation();
  return (
    <IconButton
      testID={testID}
      icon={state === "kept" ? CircleCheck : state === "downloading" ? Spinning : ArrowDownToLine}
      color={state === "off" ? colors.text : colors.accent}
      label={state === "off" ? t("parrot.kept.keep") : t("parrot.kept.remove")}
      onPress={onPress}
    />
  );
};

/** The line under a kept album's or playlist's title; nothing when it is not kept. */
export const KeptLine = ({ kind, id, kept }: { kind: KeptKind; id: string; kept: KeptView }) => {
  const { t, i18n } = useTranslation();
  const entry = kept.entry(kind, id);
  if (!entry) return null;
  return (
    <Text testID="kept-line" style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
      {entry.done < entry.total
        ? t("shell.kept.downloading", { done: entry.done, total: entry.total })
        : t("parrot.kept.line", { size: formatLocalizedStorage(entry.bytes, i18n.language) })}
    </Text>
  );
};
