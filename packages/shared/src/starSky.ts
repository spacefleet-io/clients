/**
 * The fleet's star sky (UX-SKY-02): the website hero's 150 stars and three
 * shooting stars, the one animation behind the site, Badger and Parrot on every
 * platform. On the website the stars twinkle; in the apps they stand still
 * (Chris 2026-11-16) and only the shooting stars move. This file holds every
 * number and the path maths; each platform only draws: the web with CSS and SVG
 * (`@space/ui/star-sky`), the phone and the TV with React Native
 * (`@space/mobile-shell` `MobileStarSky`).
 *
 * The values are the hero's original CSS (`packages/web-shell` StarField before
 * 2026-11-09), so the site renders exactly as it did.
 */

/** Stars spread over the whole sky, uniform in x and y (percent of the box). */
export const SKY_STAR_COUNT = 150;
/** Diameter, px: 0.6 to 2.2. */
export const SKY_STAR_SIZE_PX = { min: 0.6, span: 1.6 } as const;
/** Resting opacity: 0.2 to 0.8. */
export const SKY_STAR_OPACITY = { min: 0.2, span: 0.6 } as const;
/** One twinkle (bright, dim, bright) takes 2 to 6 s and starts 0 to 4 s late. */
export const SKY_TWINKLE_S = { min: 2, span: 4 } as const;
export const SKY_TWINKLE_DELAY_S = 4;
/** Halfway through a twinkle the star is at this share of its opacity and this scale. */
export const SKY_TWINKLE_DIM = 0.4;
export const SKY_TWINKLE_SCALE = 0.85;

/** Shooting stars, each looping forever on its own path. */
export const SKY_SHOOTING_COUNT = 3;
/** One loop takes 2 to 4 s and the first starts 0 to 6 s late. */
export const SKY_SHOOTING_DURATION_S = { min: 2, span: 2 } as const;
export const SKY_SHOOTING_DELAY_S = 6;
/** CSS rotation of the path; the head travels toward the lower left, the tail points up-right. */
export const SKY_SHOOTING_ROTATE_DEG = 315;
/** Head travel over one loop, px (visible for the first 60%, so about 900 px). */
export const SKY_SHOOTING_TRAVEL_PX = 1500;
/** The head: a 2 px white dot with a soft glow. */
export const SKY_SHOOTING_HEAD_PX = 2;
export const SKY_SHOOTING_HEAD_GLOW =
  "0 0 0 3px rgba(255, 255, 255, 0.06), 0 0 0 6px rgba(255, 255, 255, 0.03), 0 0 10px rgba(255, 255, 255, 0.6)";
/** The tail: 200 x 1 px, white at 0.9 at the head fading to nothing. */
export const SKY_SHOOTING_TAIL_PX = 200;
export const SKY_SHOOTING_TAIL_WIDTH_PX = 1;
export const SKY_SHOOTING_TAIL_OPACITY = 0.9;
export const SKY_COLOR = "#fff";
/** Opacity over one loop, [progress 0..1, opacity], linear between keys. */
export const SKY_SHOOTING_OPACITY_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.1, 1],
  [0.4, 0.6],
  [0.6, 0],
  [1, 0],
];

export type SkyStar = {
  /** Percent of the sky box. */
  x: number;
  y: number;
  sizePx: number;
  opacity: number;
  twinkleS: number;
  delayS: number;
};

export type SkyShootingStar = {
  /** Start of the head: percent from the top and from the right of the sky box. */
  top: number;
  right: number;
  durationS: number;
  delayS: number;
};

/** Same draw order as the hero always used, so a seeded random reproduces a sky. */
export const createSkyStars = (random: () => number = Math.random, count = SKY_STAR_COUNT): SkyStar[] =>
  Array.from({ length: count }, () => ({
    x: random() * 100,
    y: random() * 100,
    sizePx: random() * SKY_STAR_SIZE_PX.span + SKY_STAR_SIZE_PX.min,
    opacity: random() * SKY_STAR_OPACITY.span + SKY_STAR_OPACITY.min,
    twinkleS: random() * SKY_TWINKLE_S.span + SKY_TWINKLE_S.min,
    delayS: random() * SKY_TWINKLE_DELAY_S,
  }));

export const createSkyShootingStars = (random: () => number = Math.random, count = SKY_SHOOTING_COUNT): SkyShootingStar[] =>
  Array.from({ length: count }, () => ({
    top: random() * 100,
    right: random() * 100,
    durationS: random() * SKY_SHOOTING_DURATION_S.span + SKY_SHOOTING_DURATION_S.min,
    delayS: random() * SKY_SHOOTING_DELAY_S,
  }));

/** Opacity of a shooting star at `progress` (0..1) through its loop. */
export const shootingOpacityAt = (progress: number): number => {
  const keys = SKY_SHOOTING_OPACITY_KEYS;
  for (let i = 1; i < keys.length; i++) {
    const [p1, o1] = keys[i]!;
    if (progress <= p1) {
      const [p0, o0] = keys[i - 1]!;
      return o0 + ((o1 - o0) * (progress - p0)) / (p1 - p0);
    }
  }
  return keys[keys.length - 1]![1];
};

const RAD = Math.PI / 180;
/** Screen direction the head travels in (y down): toward the lower left. */
export const SKY_SHOOTING_DIRECTION = {
  x: -Math.cos(SKY_SHOOTING_ROTATE_DEG * RAD),
  y: -Math.sin(SKY_SHOOTING_ROTATE_DEG * RAD),
} as const;

export type SkyShootingPose = {
  /** Head offset from its start, px (screen axes, y down). */
  dx: number;
  dy: number;
  opacity: number;
};

/** Where a shooting star is `elapsedMs` after the sky started (CSS `animation-fill-mode: both`, linear). */
export const shootingStarAt = (star: SkyShootingStar, elapsedMs: number): SkyShootingPose => {
  const t = elapsedMs / 1000 - star.delayS;
  if (t < 0) return { dx: 0, dy: 0, opacity: 0 };
  const progress = (t % star.durationS) / star.durationS;
  const travel = progress * SKY_SHOOTING_TRAVEL_PX;
  return { dx: SKY_SHOOTING_DIRECTION.x * travel, dy: SKY_SHOOTING_DIRECTION.y * travel, opacity: shootingOpacityAt(progress) };
};

/**
 * The hero's stylesheet: twinkle (website only) and shooting-star keyframes and
 * the shooting star's head and tail. `[data-sky-motion]` "still" or "off"
 * removes the shooting stars.
 */
export const STAR_SKY_CSS = `
        @keyframes sf-star-twinkle {
          0%, 100% { opacity: var(--star-opacity); transform: scale(1); }
          50% { opacity: calc(var(--star-opacity) * ${SKY_TWINKLE_DIM}); transform: scale(${SKY_TWINKLE_SCALE}); }
        }
        @keyframes sf-shooting-star {
${SKY_SHOOTING_OPACITY_KEYS.map(([p, o]) =>
  p === 0
    ? `          0% { transform: rotate(${SKY_SHOOTING_ROTATE_DEG}deg) translateX(0); opacity: ${o}; }`
    : p === 1
      ? `          100% { transform: rotate(${SKY_SHOOTING_ROTATE_DEG}deg) translateX(-${SKY_SHOOTING_TRAVEL_PX}px); opacity: ${o}; }`
      : `          ${Math.round(p * 100)}% { opacity: ${o}; }`,
).join("\n")}
        }
        .sf-shooting-star {
          position: absolute;
          width: ${SKY_SHOOTING_HEAD_PX}px;
          height: ${SKY_SHOOTING_HEAD_PX}px;
          background: ${SKY_COLOR};
          border-radius: 9999px;
          box-shadow: ${SKY_SHOOTING_HEAD_GLOW};
          opacity: 0;
          transform: rotate(${SKY_SHOOTING_ROTATE_DEG}deg) translateX(0);
          animation: sf-shooting-star linear infinite;
          animation-fill-mode: both;
          will-change: transform, opacity;
        }
        .sf-shooting-star::before {
          content: "";
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: ${SKY_SHOOTING_TAIL_PX}px;
          height: ${SKY_SHOOTING_TAIL_WIDTH_PX}px;
          background: linear-gradient(90deg, rgba(255, 255, 255, ${SKY_SHOOTING_TAIL_OPACITY}), transparent);
        }
        [data-sky-motion="still"] .sf-shooting-star, [data-sky-motion="off"] .sf-shooting-star { display: none; }
`;

/** Quiet time after the last user input before the apps' sky moves again. */
export const SKY_IDLE_MS = 5_000;

/**
 * live: the shooting stars fly. still: someone is using the app, no shooting
 * star flies. off: reduced motion, playback, media processing, hidden window or
 * backgrounded app: no shooting star either. The apps' stars never move.
 */
export type SkyMotion = "live" | "still" | "off";

export type SkyMotionGateDeps = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  onChange: (motion: SkyMotion) => void;
  idleMs?: number;
};

export type SkyMotionGate = {
  /** Any user input; cheap enough for pointermove. */
  noteInput: () => void;
  /** Touch held down (phone): still until released and quiet again. */
  setInputHeld: (held: boolean) => void;
  /** Reduced motion, playback, media processing, hidden or backgrounded. */
  setBlocked: (blocked: boolean) => void;
  current: () => SkyMotion;
  dispose: () => void;
};

/**
 * The apps' gate on top of the hero animation (UX-SKY-01): the site always
 * moves; the apps hold the shooting stars back while the user interacts and
 * while something plays, media is processing, the window is hidden or reduced
 * motion is on. Starts `off` (blocked) so a renderer never moves before the app
 * says it may.
 */
export const createSkyMotionGate = ({ now, setTimer, clearTimer, onChange, idleMs = SKY_IDLE_MS }: SkyMotionGateDeps): SkyMotionGate => {
  let blocked = true;
  let held = false;
  let disposed = false;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let motion: SkyMotion = "off";
  let timer: unknown;

  const set = (next: SkyMotion) => {
    if (next === motion || disposed) return;
    motion = next;
    onChange(next);
  };
  const clear = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  const evaluate = () => {
    timer = undefined;
    if (disposed) return;
    if (blocked) return set("off");
    if (held) return set("still");
    const wait = lastInputAt + idleMs - now();
    if (wait > 0) {
      set("still");
      timer = setTimer(evaluate, wait);
      return;
    }
    set("live");
  };

  return {
    noteInput: () => {
      lastInputAt = now();
      if (motion === "live") set("still");
      if (timer === undefined && !blocked && !held) timer = setTimer(evaluate, idleMs);
    },
    setInputHeld: (next) => {
      if (next === held) return;
      held = next;
      lastInputAt = now();
      clear();
      evaluate();
    },
    setBlocked: (next) => {
      if (next === blocked) return;
      blocked = next;
      clear();
      evaluate();
    },
    current: () => motion,
    dispose: () => {
      clear();
      disposed = true;
    },
  };
};
