// Parrot's drawn album art and waveform seek bar on the phone (PAR-LOOK-01): the same pictures as the desktop app and
// the web player, from the same data (`@space/parrot-core/art`), drawn with react-native-svg and plain views. The drawn
// picture means "no cover": while a cover is on its way (downloading, its picture loading, or the automatic cover pass
// still to ask for it) a plain shimmer shows instead, so loading never looks like none (PAR-META-20).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { parrotCoverArt, parrotWaveBars } from "@space/parrot-core/art";
import { albumCoversWaiting, artistPicturesWaiting } from "../lib/picturesWaiting";
import { phoneCoverFace, phoneCoverSource } from "../lib/covers";
import { Shimmer } from "./shimmer";
import { colors, spacing } from "../theme";

/** How long a cover that just arrived takes to fade in over the drawn picture. */
export const COVER_FADE_MS = 220;

type ArtProps = {
  /** The album id: the same album always gets the same picture. */
  seed: string;
  size: number;
  radius?: number;
  /** Written on the drawn picture's bottom-left, as on a record sleeve; a real cover covers it once it has loaded. */
  label?: string;
  /** Rings the picture in green, as on the album that is playing. */
  playing?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * The key of the album's cover to show (PAR-META-04): the small copy in tiles and lists, the large one on the album
   * page and the player. Fetched by this picture alone; the drawing shows until it is there, or when it fails.
   */
  coverKey?: string | null;
  /** A cover already kept on the phone shown at once under `coverKey` while that one loads (the small copy). */
  previewKey?: string | null;
};

/**
 * The cover stored under `objectKey` as it becomes available: `uri` null while it downloads (or when there is none),
 * `pending` while it downloads, `fade` when it arrived after this picture was first drawn; a cover already kept shows
 * at once, without fading. `retry()` answers a picture that would not load: once per cover it deletes the kept file
 * and fetches it again (pending meanwhile) and answers true; after that it answers false and the drawing stays.
 */
export const useCoverUri = (objectKey: string | null | undefined) => {
  const source = phoneCoverSource();
  const kept = source?.kept(objectKey) ?? null;
  const [arrived, setArrived] = useState<{ key: string; uri: string | null } | null>(null);
  const [again, setAgain] = useState<{ key: string; uri: string | null; done: boolean } | null>(null);
  useEffect(() => {
    if (!objectKey || !source || kept) return;
    let live = true;
    void source.uriFor(objectKey).then((uri) => {
      if (live) setArrived({ key: objectKey, uri });
    });
    return () => {
      live = false;
    };
  }, [objectKey, source, kept]);
  const retried = again && again.key === objectKey ? again : null;
  const retry = () => {
    if (!objectKey || !source || retried) return false;
    setAgain({ key: objectKey, uri: null, done: false });
    // The same file under a new address, so the picture view loads it afresh instead of reusing the failed one.
    void source.refetch(objectKey).then((uri) => setAgain({ key: objectKey, uri: uri && `${uri}?retry=1`, done: true }));
    return true;
  };
  if (retried) return { uri: retried.uri, fade: true, pending: !retried.done, retry };
  const late = arrived && arrived.key === objectKey ? arrived : null;
  return { uri: late ? late.uri : kept, fade: !!late, pending: Boolean(objectKey && source && !kept && !late), retry };
};

/**
 * A cover over the drawing: transparent until its picture has loaded, then faded in (or shown at once, `fade` off).
 * `onShown` says the picture has loaded, so the shimmer under it can go.
 */
export const FadeInCover = ({ uri, fade, onError, onShown }: { uri: string; fade: boolean; onError: () => void; onShown?: () => void }) => {
  const opacity = useRef(new Animated.Value(fade ? 0 : 1)).current;
  return (
    <Animated.Image
      testID="parrot-art-image"
      source={{ uri }}
      style={[StyleSheet.absoluteFill, { opacity }]}
      resizeMode="cover"
      onLoad={() => {
        if (fade) Animated.timing(opacity, { toValue: 1, duration: COVER_FADE_MS, useNativeDriver: true }).start();
        onShown?.();
      }}
      onError={onError}
    />
  );
};

const Motif = ({ motif, light }: { motif: string; light: string }) => {
  switch (motif) {
    case "sun":
      return <Circle cx={71} cy={33} r={19} fill={light} opacity={0.85} />;
    case "stripes":
      return (
        <>
          {[-60, -44, -28, -12, 4, 20, 36, 52, 68, 84].map((x) => (
            <Rect key={x} x={x} y={-20} width={7} height={160} fill="#ffffff" opacity={0.09} transform={`rotate(45 ${x} 50)`} />
          ))}
        </>
      );
    case "rings":
      return (
        <>
          <Circle cx={23} cy={83} r={35} stroke={light} strokeWidth={2} fill="none" opacity={0.35} />
          <Circle cx={23} cy={83} r={23} stroke={light} strokeWidth={2} fill="none" opacity={0.35} />
        </>
      );
    default:
      return (
        <>
          <Circle cx={50} cy={56} r={16} fill={light} opacity={0.8} />
          <Rect x={0} y={60} width={100} height={40} fill="#000000" opacity={0.38} />
        </>
      );
  }
};

/**
 * The album's drawn picture (PAR-LOOK-01) with its own cover over it once that one is there (PAR-META-04). While the
 * cover is on its way, a shimmer stands in for the drawing (PAR-META-20): the cover downloading, its picture not loaded
 * yet, or (no cover yet) the automatic cover pass (album `seed`) or photo pass (artist `seed`) still to ask.
 */
export const ParrotArt = ({ seed, size, radius = 12, label, playing = false, style, coverKey, previewKey }: ArtProps) => {
  const art = useMemo(() => parrotCoverArt(seed), [seed]);
  const gradientId = `parrot-art-${seed}`;
  const cover = useCoverUri(coverKey);
  const preview = phoneCoverSource()?.kept(previewKey && previewKey !== coverKey ? previewKey : null) ?? null;
  // The URI that failed to load again after one fresh fetch (`cover.retry`): it leaves the drawn picture.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  // The URI whose picture has loaded: the shimmer under it goes.
  const [shownUri, setShownUri] = useState<string | null>(null);
  // `seed` is the album's id for a cover and the artist's for a photo: either pass may still have it to ask.
  const [passWaiting, setPassWaiting] = useState(albumCoversWaiting.has(seed) || artistPicturesWaiting.has(seed));
  useEffect(() => {
    const read = () => setPassWaiting(albumCoversWaiting.has(seed) || artistPicturesWaiting.has(seed));
    read();
    const offAlbums = albumCoversWaiting.onChange(read);
    const offArtists = artistPicturesWaiting.onChange(read);
    return () => {
      offAlbums();
      offArtists();
    };
  }, [seed]);
  const image = phoneCoverFace(cover.uri, failedUri);
  const shimmer = !preview && (cover.pending || (image !== null && shownUri !== image) || (!coverKey && passWaiting));
  return (
    <View
      testID="parrot-art"
      accessibilityState={{ busy: shimmer }}
      style={[{ width: size, height: size, borderRadius: radius }, styles.art, playing && styles.playing, style]}
    >
      {shimmer ? (
        <Shimmer testID="parrot-art-shimmer" style={StyleSheet.absoluteFill} />
      ) : (
        <>
          <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={art.from} />
                <Stop offset="1" stopColor={art.to} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={100} height={100} fill={`url(#${gradientId})`} />
            <Motif motif={art.motif} light={art.light} />
          </Svg>
          {label ? (
            <Text style={[styles.label, { fontSize: Math.max(9, Math.round(size / 14)) }]} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </>
      )}
      {preview ? <Image testID="parrot-art-preview" source={{ uri: preview }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      {image ? (
        <FadeInCover key={image} uri={image} fade={cover.fade} onShown={() => setShownUri(image)} onError={() => cover.retry() || setFailedUri(image)} />
      ) : null}
    </View>
  );
};

type WaveProps = {
  /** The song id: the same song always draws the same wave. */
  seed: string;
  /** Played share, 0 to 1. */
  progress: number;
  onSeek: (fraction: number) => void;
  accessibilityLabel: string;
  accessibilityValue: { min: number; max: number; now: number };
  onStep: (direction: 1 | -1) => void;
  bars?: number;
  height?: number;
};

/** The bars of a song's wave (PAR-LOOK-01): the shared `parrotWaveBars` shape, green up to the played share. The TV draws them at its own size. */
export const WaveBars = ({ seed, progress, bars, height }: { seed: string; progress: number; bars: number; height: number }) => {
  const heights = useMemo(() => parrotWaveBars(seed, bars), [seed, bars]);
  const played = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return <>{heights.map((h, i) => (
    <View
      key={i}
      pointerEvents="none"
      style={[styles.waveBar, { height: Math.max(3, h * height), backgroundColor: (i + 0.5) / heights.length <= played ? colors.accent : colors.surfaceRaised }]}
    />
  ))}</>;
};

/** The waveform seek bar (PAR-LOOK-01): green up to the playing point; tap to seek, swipe up/down with TalkBack to step. */
export const WaveSeek = ({ seed, progress, onSeek, accessibilityLabel, accessibilityValue, onStep, bars = 56, height = 44 }: WaveProps) => {
  const [width, setWidth] = useState(0);
  return (
    <Pressable
      testID="player-wave-seek"
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => onStep(event.nativeEvent.actionName === "increment" ? 1 : -1)}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      onPress={(event) => {
        if (width > 0) onSeek(Math.max(0, Math.min(1, event.nativeEvent.locationX / width)));
      }}
      style={[styles.wave, { height }]}
    >
      <WaveBars seed={seed} progress={progress} bars={bars} height={height} />
    </Pressable>
  );
};

/** Home's "Jump back in" wave (PAR-HOME-01): the song to resume and how far it got, drawn faint like the demo's card. */
export const HomeWave = ({ seed, progress, bars = 36, height = 30 }: { seed: string; progress: number; bars?: number; height?: number }) => (
  <View testID="home-jump-wave" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.wave, styles.homeWave, { height }]}>
    <WaveBars seed={seed} progress={progress} bars={bars} height={height} />
  </View>
);

const styles = StyleSheet.create({
  art: { overflow: "hidden", backgroundColor: colors.surface },
  playing: { borderWidth: 2, borderColor: colors.accent },
  label: { position: "absolute", left: "9%", right: "9%", bottom: "7%", color: "#ffffff", fontWeight: "700" },
  wave: { flexDirection: "row", alignItems: "center", gap: 2 },
  homeWave: { opacity: 0.5, marginTop: spacing.sm },
  waveBar: { flex: 1, borderRadius: 2 },
});
