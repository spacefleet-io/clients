/**
 * The animated mascot on the apps' loading screens (UX-WAIT-02): Badger hovering, Parrot nodding to the beat while
 * music notes float up from his headphones. One motion for every platform, painted from these numbers: the web and
 * the desktop with the Web Animations API (`@space/ui/mascot-loader`), the phone and the TV with React Native's own
 * `Animated` and `react-native-svg` (`@space/mobile-shell/mascot-loader`).
 *
 * The mascot is each app's existing picture, only moved, so it stays on-model; the music notes are drawn as vectors.
 * Coordinates live in a 320 x 320 box; renderers scale it to their size. Every curve is periodic in `t` (0..1), so
 * the loop is seamless.
 */

export type MascotLoaderApp = "badger" | "parrot";

/** One layer's pose: its centre, turn (degrees), stretch and opacity. */
export type MascotLoaderPose = {
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
};

/** A vector shape of a prop, in the prop's own units around (0, 0). */
export type MascotLoaderShape =
  | { kind: "path"; d: string }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotate: number };

export type MascotLoaderLayer =
  | { kind: "mascot"; id: string; width: number; height: number }
  | { kind: "prop"; id: string; fill: string; shapes: readonly MascotLoaderShape[] };

export type MascotLoaderSpec = {
  durationMs: number;
  /** Bottom to top. */
  layers: readonly MascotLoaderLayer[];
  /** The pose of each layer (same order) at loop time `t` in [0, 1). */
  pose: (t: number) => MascotLoaderPose[];
};

/** Side of the square box every pose is expressed in. */
export const MASCOT_LOADER_BOX = 320;

/** The props' outline colour: the mascots' own dark outline. */
export const MASCOT_LOADER_OUTLINE = "#1f2440";

/** How many evenly spaced poses a renderer samples per loop (25 per second over 1.6 s). */
export const MASCOT_LOADER_SAMPLES = 40;

const TAU = Math.PI * 2;

/** Height / width of each app's mascot picture once its transparent margin is trimmed. */
const BADGER_ASPECT = 512 / 537;
const PARROT_ASPECT = 240 / 205;

const NOTE_SINGLE: readonly MascotLoaderShape[] = [
  { kind: "path", d: "M3,6 L3,-22 Q10,-18 15,-10 Q11,-13 7,-14 L7,6Z" },
  { kind: "ellipse", cx: -2, cy: 7, rx: 8, ry: 6, rotate: -20 },
];
const NOTE_DOUBLE: readonly MascotLoaderShape[] = [
  { kind: "path", d: "M-6,6 L-6,-18 L16,-24 L16,1 L12,1 L12,-14 L-2,-10 L-2,6Z" },
  { kind: "ellipse", cx: -10, cy: 7, rx: 7, ry: 5.5, rotate: -20 },
  { kind: "ellipse", cx: 8, cy: 2, rx: 7, ry: 5.5, rotate: -20 },
];

const BADGER_WIDTH = 228;
const BADGER: MascotLoaderSpec = {
  durationMs: 1600,
  layers: [{ kind: "mascot", id: "badger", width: BADGER_WIDTH, height: BADGER_WIDTH * BADGER_ASPECT }],
  // Floats up and down 7 units with a slight 3-degree sway, once per loop.
  pose: (t) => [
    { x: 160, y: 160 + 7 * Math.sin(TAU * t), rotate: 3 * Math.sin(TAU * t + 0.6), scaleX: 1, scaleY: 1, opacity: 1 },
  ],
};

const PARROT_WIDTH = 176;
const PARROT_HEIGHT = PARROT_WIDTH * PARROT_ASPECT;
const NOTES = [
  { id: "note-green", fill: "#00e676", shapes: NOTE_SINGLE },
  { id: "note-lime", fill: "#c6ff3d", shapes: NOTE_DOUBLE },
  { id: "note-gold", fill: "#ffd54a", shapes: NOTE_SINGLE },
] as const;

const parrotPose = (t: number): MascotLoaderPose[] => {
  // Two bounces per loop, like nodding on the beat; a small squash only at the bottom of each bounce; leans left on
  // one beat and right on the next. The turn and squash pivot on the parrot's feet.
  const beat = Math.abs(Math.sin(TAU * t));
  const lift = 10 * beat;
  const scaleY = 1 - 0.035 * (1 - beat) ** 4;
  const scaleX = 1 / Math.sqrt(scaleY);
  const tilt = 5 * Math.sin(TAU * t);
  const tiltRad = (tilt * Math.PI) / 180;
  const half = (PARROT_HEIGHT / 2) * scaleY;
  const footY = 180 - lift + PARROT_HEIGHT / 2;
  const body: MascotLoaderPose = {
    x: 150 + half * Math.sin(tiltRad),
    y: footY - half * Math.cos(tiltRad),
    rotate: tilt,
    scaleX,
    scaleY,
    opacity: 1,
  };
  // Three notes rise from the headphones a third of a loop apart, drifting right, fading in, then out; each is gone just before it restarts, so the jump back is never seen.
  const notes = NOTES.map((_, k): MascotLoaderPose => {
    const p = (t + k / 3) % 1;
    const grow = 1.05 + 0.4 * Math.min(1, p / 0.25);
    return {
      x: 222 + 38 * p + 8 * Math.sin(TAU * p * 1.5 + k),
      y: 118 - 92 * p,
      rotate: -12 + 24 * Math.sin(TAU * p),
      scaleX: grow,
      scaleY: grow,
      opacity: Math.max(0, Math.min(1, p / 0.18, (0.95 - p) / 0.25)),
    };
  });
  return [body, ...notes];
};

const PARROT: MascotLoaderSpec = {
  durationMs: 1600,
  layers: [
    { kind: "mascot", id: "parrot", width: PARROT_WIDTH, height: PARROT_HEIGHT },
    ...NOTES.map((note): MascotLoaderLayer => ({ kind: "prop", ...note })),
  ],
  pose: parrotPose,
};

export const MASCOT_LOADERS: Record<MascotLoaderApp, MascotLoaderSpec> = { badger: BADGER, parrot: PARROT };

/**
 * Where the loop stands at `nowMs`, 0..1, on one clock shared by every loader: the epoch. A loading screen that
 * hands over to the next during launch (app shell, then profiles, then library) mounts a fresh loader; started at
 * the loop's beginning, the mascot snapped back mid-motion at each handover. Starting at this phase instead, the
 * new loader takes the motion up where the old one was.
 */
export const mascotLoaderPhase = (app: MascotLoaderApp, nowMs: number = Date.now()): number => {
  const { durationMs } = MASCOT_LOADERS[app];
  return (((nowMs % durationMs) + durationMs) % durationMs) / durationMs;
};

/**
 * `MASCOT_LOADER_SAMPLES + 1` evenly spaced poses per layer, the last equal to the first, for renderers that
 * interpolate between keyframes. Result: `[layer][sample]`. The samples start at `phase` (see `mascotLoaderPhase`)
 * and wrap round, so a plain 0..1 loop over them runs in step with every other loader on screen.
 */
export const mascotLoaderKeyframes = (app: MascotLoaderApp, phase = 0): MascotLoaderPose[][] => {
  const spec = MASCOT_LOADERS[app];
  const samples = Array.from({ length: MASCOT_LOADER_SAMPLES + 1 }, (_, i) => {
    const t = (i % MASCOT_LOADER_SAMPLES) / MASCOT_LOADER_SAMPLES + phase;
    return spec.pose(t >= 1 ? t - 1 : t);
  });
  return spec.layers.map((_, layer) => samples.map((poses) => poses[layer]!));
};
