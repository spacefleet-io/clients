/**
 * The apps' nebulas under the star sky (UX-SKY-03): soft glows of colour over the
 * dark ground, one set per app, painted by every platform from these numbers:
 * the web as CSS radial gradients (`nebulaCss`, `@space/ui` AppBackdrop), the
 * phone and the TV as SVG radial gradients (`mobileNebulaSpots`, `MobileNebula`).
 *
 * Parrot's green nebula is the approved Parrot design's (PAR-LOOK-01) glows, 2.5 times as strong (Chris,
 * 2026-11-10: visible at a glance). Badger's is the same three glows in Badger's accent yellow (the Resume
 * button, `--primary: 33 100% 67%`), at the same strength and softness.
 */

export type SkyNebulaName = "parrot" | "badger";

export type SkyNebulaGlow = {
  /** Centre, as a fraction of the screen (may lie off screen). */
  x: number;
  y: number;
  /** Radii on the web, rem. */
  rxRem: number;
  ryRem: number;
  /** HSL colour. */
  hue: number;
  sat: number;
  light: number;
  /** Opacity at the centre; it fades to nothing at NEBULA_FADE_AT of the radius. */
  opacity: number;
};

/** Where a glow has faded out, as a share of its radius. */
export const NEBULA_FADE_AT = 0.6;
/**
 * The desktop window the nebula's rem sizes are judged at (1280 × 800 px, 16 px to the rem). The phone and the TV
 * draw each glow at the same share of their own screen's width and height as it covers in this window, so a tall
 * phone gets the desktop's warm top third instead of a thin strip along its top edge.
 */
export const NEBULA_REFERENCE_WINDOW = { width: 1280, height: 800, pxPerRem: 16 } as const;

/** Top left, top right, below: the layout both apps share. */
const glows = (colours: ReadonlyArray<readonly [number, number, number, number]>): SkyNebulaGlow[] => {
  const layout = [
    { x: 0.12, y: -0.08, rxRem: 60, ryRem: 30 },
    { x: 0.92, y: 0.04, rxRem: 50, ryRem: 28 },
    { x: 0.6, y: 1.1, rxRem: 40, ryRem: 30 },
  ];
  return layout.map((spot, i) => {
    const [hue, sat, light, opacity] = colours[i]!;
    return { ...spot, hue, sat, light, opacity };
  });
};

export const SKY_NEBULAS: Record<SkyNebulaName, SkyNebulaGlow[]> = {
  // Green top left, teal top right, a touch of violet below.
  parrot: glows([
    [150, 75, 45, 0.35],
    [172, 65, 45, 0.25],
    [262, 70, 62, 0.2],
  ]),
  // Badger's accent yellow top left, a lighter gold top right, the same touch of violet below
  // (agent reading, approved by Main (2026-11-08)).
  badger: glows([
    [33, 100, 67, 0.35],
    [45, 100, 62, 0.25],
    [262, 70, 62, 0.2],
  ]),
};

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** The CSS `background-image` of a nebula. */
export const nebulaCss = (name: SkyNebulaName): string =>
  SKY_NEBULAS[name]
    .map(
      (g) =>
        `radial-gradient(${g.rxRem}rem ${g.ryRem}rem at ${pct(g.x)} ${pct(g.y)}, hsl(${g.hue} ${g.sat}% ${g.light}% / ${g.opacity}), transparent ${pct(NEBULA_FADE_AT)})`,
    )
    .join(", ");

/**
 * One glow for React Native's `MobileNebula`: `x`/`y` its centre and `rx`/`ry` its radii, all as fractions of the
 * screen's width (`x`, `rx`) and height (`y`, `ry`).
 */
export type MobileNebulaGlow = { x: number; y: number; rx: number; ry: number; color: string; opacity: number };

/** A nebula sized as shares of the screen, as it covers the reference desktop window, for `MobileNebula`. */
export const mobileNebulaSpots = (name: SkyNebulaName): MobileNebulaGlow[] => {
  const { width, height, pxPerRem } = NEBULA_REFERENCE_WINDOW;
  return SKY_NEBULAS[name].map((g) => ({
    x: g.x,
    y: g.y,
    rx: (g.rxRem * pxPerRem) / width,
    ry: (g.ryRem * pxPerRem) / height,
    color: `hsl(${g.hue}, ${g.sat}%, ${g.light}%)`,
    opacity: g.opacity,
  }));
};
