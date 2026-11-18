import { memo, useMemo } from "react";
import { SKY_COLOR, STAR_SKY_CSS, createSkyShootingStars, createSkyStars, type SkyStar } from "@space/shared/starSky";

type StarSkyProps = {
  /** The website's hero: the stars twinkle. The apps leave it off: their stars stand still (UX-SKY-02). */
  twinkle?: boolean;
};

/** The website's stars: one span each, twinkling with CSS, exactly as the hero always drew them. */
const TwinklingStars = ({ stars }: { stars: SkyStar[] }) =>
  stars.map((star, index) => (
    <span
      key={`star-${index}`}
      data-testid="sky-star"
      className="sf-sky-star"
      style={{
        position: "absolute",
        borderRadius: 9999,
        background: "#fff",
        left: `${star.x}%`,
        top: `${star.y}%`,
        width: `${star.sizePx}px`,
        height: `${star.sizePx}px`,
        opacity: star.opacity,
        animation: `sf-star-twinkle ${star.twinkleS}s ease-in-out ${star.delayS}s infinite`,
        ["--star-opacity" as string]: star.opacity,
      }}
    />
  ));

/**
 * The apps' stars: one still SVG, no animation, painted once, so nothing in it
 * is restyled or repainted while the shooting stars fly (Chris 2026-11-16). A
 * star is centred at x% / y% of the box; its size stays in px whatever the box.
 */
const StillStars = ({ stars }: { stars: SkyStar[] }) => (
  <svg data-testid="sky-stars" aria-hidden="true" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
    {stars.map((star, index) => (
      <circle key={`star-${index}`} data-testid="sky-star" cx={`${star.x}%`} cy={`${star.y}%`} r={star.sizePx / 2} fill={SKY_COLOR} opacity={star.opacity} />
    ))}
  </svg>
);

/**
 * The web renderer of the fleet's star sky (UX-SKY-02): the website hero's 150
 * stars and its three looping shooting stars, from the numbers in
 * `@space/shared/starSky`. The site's `StarField` draws it with `twinkle`; the
 * apps' `AppBackdrop` without, so their stars stand still. The box around it
 * (position, z-index) is theirs.
 *
 * An ancestor's `data-sky-motion` "still" or "off" removes the shooting stars.
 * Without it they always fly, as on the site. Styles are inline so every app's
 * Tailwind build draws it the same.
 */
function StarSky({ twinkle = false }: StarSkyProps) {
  const stars = useMemo(() => createSkyStars(), []);
  const shootingStars = useMemo(() => createSkyShootingStars(), []);

  return (
    <>
      <style>{STAR_SKY_CSS}</style>
      {twinkle ? <TwinklingStars stars={stars} /> : <StillStars stars={stars} />}
      {shootingStars.map((star, index) => (
        <span
          key={`shooting-star-${index}`}
          data-testid="sky-shooting-star"
          className="sf-shooting-star"
          style={{
            top: `${star.top}%`,
            right: `${star.right}%`,
            animationDuration: `${star.durationS}s`,
            animationDelay: `${star.delayS}s`,
          }}
        />
      ))}
    </>
  );
}

export default memo(StarSky);
