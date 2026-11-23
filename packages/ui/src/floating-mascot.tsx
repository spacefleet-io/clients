import { cn } from "./utils";

/** Each app's glow under its mascot, in the app's accent (Badger yellow, Parrot green). */
export const MASCOT_GLOW = {
  badger: "drop-shadow-[0_0_30px_rgba(255,170,84,0.3)]",
  parrot: "drop-shadow-[0_0_30px_rgba(64,221,143,0.3)]",
} as const;

type FloatingMascotProps = {
  src: string;
  alt?: string;
  /** The glow under the mascot (`MASCOT_GLOW`); Badger's by default. */
  glowClassName?: string;
  /** Places the 80 px mascot box (the sign-in card lifts it above the card, the crash screen centres it). */
  className?: string;
  testId?: string;
};

/**
 * The floating, glowing app mascot of the sign-in screens (UX-THEME-02), one piece for every web and desktop screen
 * that shows it: the startup card, the Parrot web player's pairing screen and the whole-window crash screen
 * (UX-CRASH-01). The float animation is `.animate-float` from `@space/ui/styles/float.css`.
 */
export const FloatingMascot = ({ src, alt = "", glowClassName = MASCOT_GLOW.badger, className, testId }: FloatingMascotProps) => (
  <div className={cn("h-20 w-20 animate-float", className)} data-testid={testId}>
    <img src={src} alt={alt} className={cn("h-full w-full object-contain", glowClassName)} />
  </div>
);
