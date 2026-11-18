import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { WINDOW_DROP_PASSES } from "../window-drop";
import { desktopTourText, type DesktopTourStringKey } from "./strings";
import {
  DESKTOP_TOUR_START_EVENT,
  DESKTOP_TOUR_STEPS,
  isDesktopTourRequested,
  isDesktopTourStepSeen,
  markDesktopTourStepSeen,
  skipDesktopTour,
  takeDesktopTourRequest,
  type DesktopTourStepId,
} from "./seen";

export type DesktopTourApp = "badger" | "parrot";
export type DesktopTourPlacement = "top" | "bottom" | "left" | "right" | "center";

/**
 * The places the tour reads from the app, each marked `data-tour="…"`: the import review dialog once it lists what was
 * found (step 2), the jobs panel while it is open and the top bar's jobs button that opens it (step 3). The jobs button
 * also carries `data-tour-jobs-count`, how many jobs the panel lists, so the tour sees the first job appear.
 */
export const DESKTOP_TOUR_TARGETS = { review: "import-review", jobsPanel: "jobs-panel", jobsButton: "jobs" } as const;

/** The selector of a control marked `data-tour="<id>"`. */
export const tourTarget = (id: string): string => `[data-tour="${id}"]`;

type Rect = { top: number; left: number; width: number; height: number };
type Size = { width: number; height: number };

const SPOTLIGHT_PADDING = 8;
const CARD_GAP = 14;
const VIEWPORT_MARGIN = 16;
const CARD_WIDTH = 360;
/**
 * Step 1's modal is wider than the other cards so its video reads well (Chris 2026-11-12: "it could be bigger with
 * the video bigger too"). It narrows to 90vw, and on a short window to the width whose 16:9 video still leaves room
 * for the words and buttons (about 250px of them), so the whole modal fits without scrolling.
 */
const INTRO_WIDTH = 576;
const INTRO_CHROME_HEIGHT = 260;
const INTRO_STYLE: CSSProperties = {
  width: `min(${INTRO_WIDTH}px, 90vw, calc((100vh - ${INTRO_CHROME_HEIGHT}px) * 16 / 9 + 40px))`,
  maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
  maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
};
const DIM = "rgba(6, 8, 16, 0.72)";
/** After a drop on step 1, how long the modal stays hidden waiting for the import to show before it comes back. */
const DROP_WAIT_MS = 8_000;

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height));

/** The first element matching one of `target`'s selectors that is laid out on screen, or null. */
export const findTourTarget = (target: string | readonly string[] | undefined, root: ParentNode = document): HTMLElement | null => {
  if (!target) return null;
  const selectors = typeof target === "string" ? [target] : target;
  for (const selector of selectors) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return element;
    }
  }
  return null;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where a card goes: beside the lit control on the asked side, flipped to the other side when it does not fit, and
 * kept inside the window. With no control, in the middle of the window.
 */
export const placeTourCard = (
  spot: Rect | null,
  card: Size,
  viewport: Size,
  placement: DesktopTourPlacement = "bottom",
): { top: number; left: number; side: DesktopTourPlacement } => {
  const center = {
    top: Math.max(VIEWPORT_MARGIN, (viewport.height - card.height) / 2),
    left: Math.max(VIEWPORT_MARGIN, (viewport.width - card.width) / 2),
    side: "center" as const,
  };
  if (!spot || placement === "center") return center;
  const fits: Record<Exclude<DesktopTourPlacement, "center">, boolean> = {
    bottom: spot.top + spot.height + CARD_GAP + card.height <= viewport.height - VIEWPORT_MARGIN,
    top: spot.top - CARD_GAP - card.height >= VIEWPORT_MARGIN,
    right: spot.left + spot.width + CARD_GAP + card.width <= viewport.width - VIEWPORT_MARGIN,
    left: spot.left - CARD_GAP - card.width >= VIEWPORT_MARGIN,
  };
  const opposite = { bottom: "top", top: "bottom", left: "right", right: "left" } as const;
  const order: Exclude<DesktopTourPlacement, "center">[] = [placement, opposite[placement], "bottom", "top", "right", "left"];
  const side = order.find((candidate) => fits[candidate]);
  if (!side) return center;
  const horizontalLeft = clamp(spot.left + spot.width / 2 - card.width / 2, VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN);
  const verticalTop = clamp(spot.top + spot.height / 2 - card.height / 2, VIEWPORT_MARGIN, viewport.height - card.height - VIEWPORT_MARGIN);
  switch (side) {
    case "bottom":
      return { top: spot.top + spot.height + CARD_GAP, left: horizontalLeft, side };
    case "top":
      return { top: spot.top - CARD_GAP - card.height, left: horizontalLeft, side };
    case "right":
      return { top: verticalTop, left: spot.left + spot.width + CARD_GAP, side };
    case "left":
      return { top: verticalTop, left: spot.left - CARD_GAP - card.width, side };
  }
};

const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The rectangle of `element` with the spotlight's margin, or null while it is not laid out. */
const spotOf = (element: HTMLElement | null): Rect | null => {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    top: rect.top - SPOTLIGHT_PADDING,
    left: rect.left - SPOTLIGHT_PADDING,
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  };
};

/** Follows `element` on screen (layout shifts, scrolling, resizing) every frame. */
const useSpot = (element: HTMLElement | null): { spot: Rect | null; viewport: Size } => {
  const [spot, setSpot] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState<Size>(viewportSize);
  useLayoutEffect(() => {
    let frame = 0;
    let current: Rect | null | undefined;
    const measure = () => {
      const next = spotOf(element);
      if (current === undefined || !sameRect(current, next)) {
        current = next;
        setSpot(next);
      }
      const size = viewportSize();
      setViewport((previous) => (previous.width === size.width && previous.height === size.height ? previous : size));
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [element]);
  return { spot, viewport };
};

const STEP_NUMBER: Record<DesktopTourStepId, number> = { intro: 1, review: 2, jobs: 3 };

const buttonFocus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * One card of the tour: "Step N of 3" and Skip tour on top, the title and the sentence, then the progress dots (they
 * only show where you are; there is no Back or Next) and the step's own action.
 */
function TourCard({
  step,
  language,
  titleKey,
  bodyKey,
  media,
  action,
  onSkip,
  testId,
  className,
  style,
  cardRef,
  modal = false,
}: {
  step: DesktopTourStepId;
  language: string;
  titleKey: DesktopTourStringKey;
  bodyKey: DesktopTourStringKey;
  media?: ReactNode;
  action: ReactNode;
  onSkip: () => void;
  testId: string;
  className: string;
  style?: CSSProperties;
  cardRef?: Ref<HTMLDivElement>;
  modal?: boolean;
}) {
  const titleId = useId();
  const bodyId = useId();
  const text = (key: DesktopTourStringKey, vars?: Record<string, string | number>) => desktopTourText(language, key, vars);
  return (
    <div
      ref={cardRef}
      role={modal ? "dialog" : "region"}
      aria-modal={modal ? "true" : undefined}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid={`${testId}-card`}
      data-step={step}
      data-tour-root=""
      className={`rounded-2xl border border-border bg-card px-5 pb-4 pt-5 text-left text-card-foreground shadow-[0_24px_60px_rgba(0,0,0,0.55)] ${className}`}
      style={{ width: CARD_WIDTH, maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`, pointerEvents: "auto", ...style }}
      {...(modal ? WINDOW_DROP_PASSES : {})}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11.5px] font-semibold tracking-[0.02em] text-primary" data-testid={`${testId}-progress`}>
          {text("stepOf", { n: STEP_NUMBER[step], m: DESKTOP_TOUR_STEPS.length })}
        </div>
        <button
          type="button"
          className={`rounded text-[13px] text-muted-foreground underline underline-offset-[3px] hover:text-foreground ${buttonFocus}`}
          onClick={onSkip}
          data-testid={`${testId}-skip`}
        >
          {text("skip")}
        </button>
      </div>
      {media}
      <h2 id={titleId} className="mt-1.5 text-[19px] font-semibold leading-snug text-foreground">
        {text(titleKey)}
      </h2>
      <p id={bodyId} className="mt-2 text-sm leading-normal text-muted-foreground">
        {text(bodyKey)}
      </p>
      <div className="mt-4 flex items-center gap-2.5">
        <div aria-hidden className="mr-auto flex gap-1.5" data-testid={`${testId}-dots`}>
          {DESKTOP_TOUR_STEPS.map((dot) => (
            <i key={dot} className={dot === step ? "h-[7px] w-5 rounded bg-primary" : "size-[7px] rounded-full bg-border"} />
          ))}
        </div>
        {action}
      </div>
    </div>
  );
}

const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * Step 1 (UX-TOUR-01, PAR-TOUR-01): a modal in the middle of the dimmed window asking for the first file, with a short
 * looping video of a file dragged from a folder onto the window. It has no Next: it ends when a real import starts
 * (a drop anywhere on the window, or files chosen with "or pick files"), or with Skip tour (or Esc). A drop is not
 * taken by the modal: it reaches the app's window drop, and the modal hides while files are dragged over the window.
 */
export function DesktopTourIntro({
  app,
  language,
  videoSrc,
  onPickFiles,
  onImported,
  onSkip,
  importShown,
  testId = "desktop-tour",
}: {
  app: DesktopTourApp;
  language: string;
  videoSrc: string;
  /** Opens the app's file picker and starts the import; resolves whether files were chosen. */
  onPickFiles: () => Promise<boolean>;
  onImported: () => void;
  onSkip: () => void;
  /** The app is showing what the import opened (its import dialog). */
  importShown: boolean;
  testId?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [picking, setPicking] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const text = (key: DesktopTourStringKey) => desktopTourText(language, key);

  useEffect(() => {
    if (importShown) onImported();
  }, [importShown, onImported]);

  // Hide while files are dragged over the window, so the app's own drop overlay shows; a drop starts the import.
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth = 0;
      setDragging(false);
      setDropped(true);
    };
    const onNativeDrop = () => setDropped(true);
    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("sf:native-file-drop", onNativeDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter, true);
      window.removeEventListener("dragleave", onLeave, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("sf:native-file-drop", onNativeDrop);
    };
  }, []);

  // A drop the app refused (no video or song in it) opens nothing: the modal comes back.
  useEffect(() => {
    if (!dropped) return;
    const timer = window.setTimeout(() => setDropped(false), DROP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [dropped]);

  // Focus moves into the modal and goes back where it was when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pickRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await onPickFiles();
      console.info(`[desktop-tour] pick files: ${picked ? "picked" : "cancelled"}`);
      if (picked) onImported();
    } finally {
      setPicking(false);
    }
  };

  const hidden = dragging || dropped;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`fixed inset-0 z-[2000] flex items-center justify-center ${hidden ? "pointer-events-none opacity-0" : ""}`}
      style={{ background: DIM }}
      data-testid={testId}
      data-step="intro"
      data-hidden={hidden ? "true" : "false"}
      data-tour-root=""
      {...WINDOW_DROP_PASSES}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onSkip();
        } else if (event.key === "Tab") {
          const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          const active = document.activeElement;
          if (event.shiftKey && (active === first || !cardRef.current?.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (active === last || !cardRef.current?.contains(active))) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <TourCard
        modal
        cardRef={cardRef}
        step="intro"
        language={language}
        titleKey={`${app}.intro.title`}
        bodyKey={`${app}.intro.body`}
        onSkip={onSkip}
        testId={testId}
        className=""
        style={INTRO_STYLE}
        media={
          <video
            className="mt-3 mb-1 aspect-video w-full rounded-xl border border-border bg-background object-cover"
            src={videoSrc}
            autoPlay
            loop
            muted
            playsInline
            aria-label={text("videoLabel")}
            data-testid={`${testId}-video`}
          />
        }
        action={
          <button
            ref={pickRef}
            type="button"
            disabled={picking}
            className={`rounded-[10px] bg-secondary px-3.5 py-2 text-[13.5px] font-semibold text-foreground hover:bg-secondary/80 disabled:opacity-60 ${buttonFocus}`}
            onClick={() => void pick()}
            data-testid={`${testId}-pick-files`}
          >
            {text("pickFiles")}
          </button>
        }
      />
    </div>,
    document.body,
  );
}

const gotItButton = (language: string, onClick: () => void, testId: string) => (
  <button
    type="button"
    className={`rounded-[10px] bg-primary px-3.5 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 ${buttonFocus}`}
    onClick={onClick}
    data-testid={`${testId}-got-it`}
  >
    {desktopTourText(language, "gotIt")}
  </button>
);

/** The ring around a control (the jobs button), drawn above everything and never in the way of a click. */
function TourRing({ element, dim, testId }: { element: HTMLElement | null; dim: boolean; testId: string }) {
  const { spot } = useSpot(element);
  if (!spot) return dim ? <div aria-hidden className="pointer-events-none fixed inset-0 z-[2000]" style={{ background: DIM }} /> : null;
  return (
    <div
      aria-hidden
      data-testid={`${testId}-spotlight`}
      className={`pointer-events-none fixed z-[2000] rounded-[14px] outline outline-2 outline-primary ${reducedMotion() ? "" : "transition-all duration-200 ease-out"}`}
      style={{
        top: spot.top,
        left: spot.left,
        width: spot.width,
        height: spot.height,
        boxShadow: dim ? `0 0 0 6px hsl(var(--primary) / 0.18), 0 0 0 9999px ${DIM}` : "0 0 0 6px hsl(var(--primary) / 0.18)",
      }}
    />
  );
}

/** Step 3 with the panel closed: the jobs button lit in the dimmed window, the card beside it. Clicks go through. */
function JobsButtonStep({
  app,
  language,
  button,
  onDone,
  onSkip,
  testId,
}: {
  app: DesktopTourApp;
  language: string;
  button: HTMLElement;
  onDone: () => void;
  onSkip: () => void;
  testId: string;
}) {
  const { spot, viewport } = useSpot(button);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState<Size>({ width: CARD_WIDTH, height: 200 });
  useLayoutEffect(() => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (rect && rect.height > 0 && (Math.round(rect.height) !== Math.round(cardSize.height) || Math.round(rect.width) !== Math.round(cardSize.width))) {
      setCardSize({ width: rect.width, height: rect.height });
    }
  });
  const position = placeTourCard(spot, cardSize, viewport, "bottom");
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[2000]" data-testid={testId} data-step="jobs" data-variant="button" data-tour-root="">
      <TourRing element={button} dim testId={testId} />
      <TourCard
        cardRef={cardRef}
        step="jobs"
        language={language}
        titleKey={`${app}.jobs.title`}
        bodyKey={`${app}.jobs.body`}
        onSkip={onSkip}
        testId={testId}
        className={`fixed z-[2001] ${reducedMotion() ? "" : "transition-all duration-200 ease-out"}`}
        style={{ top: position.top, left: position.left }}
        action={gotItButton(language, onDone, testId)}
      />
    </div>,
    document.body,
  );
}

type TourScene = {
  review: HTMLElement | null;
  panel: HTMLElement | null;
  jobsButton: HTMLElement | null;
  jobsCount: number;
  /** A dialog of the app other than the jobs panel is open (the jobs button card waits for it to close). */
  otherDialog: boolean;
};

const readScene = (): TourScene => {
  const review = document.querySelector<HTMLElement>(tourTarget(DESKTOP_TOUR_TARGETS.review));
  const panel = document.querySelector<HTMLElement>(`${tourTarget(DESKTOP_TOUR_TARGETS.jobsPanel)}[data-state="open"]`);
  const jobsButton = document.querySelector<HTMLElement>(tourTarget(DESKTOP_TOUR_TARGETS.jobsButton));
  const jobsCount = Number(jobsButton?.getAttribute("data-tour-jobs-count") ?? 0) || 0;
  const otherDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')).some(
    (dialog) => !dialog.closest("[data-tour-root]") && dialog !== panel,
  );
  return { review, panel, jobsButton, jobsCount, otherDialog };
};

/** Watches the app's marked places (`DESKTOP_TOUR_TARGETS`) for the tour's events. */
const useTourScene = (): TourScene => {
  const [scene, setScene] = useState<TourScene>(readScene);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const next = readScene();
      setScene((previous) =>
        (Object.keys(next) as (keyof TourScene)[]).every((key) => previous[key] === next[key]) ? previous : next,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(check);
    };
    check();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-tour", "data-tour-jobs-count", "data-state", "role"],
    });
    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  return scene;
};

/**
 * The first-open tour of Badger and Parrot (UX-TOUR-01..02/04, PAR-TOUR-01..02/04), three steps that each show once,
 * at the moment they are about:
 * 1. on Home, once `ready`: the drop modal (`DesktopTourIntro`), which ends when an import starts;
 * 2. when the import dialog lists what it found (`data-tour="import-review"`): a card inside that dialog;
 * 3. when the jobs panel opens or the first job appears: a card in the panel with the jobs button lit (it reopens the
 *    panel), or, panel closed, the jobs button lit with the card beside it.
 * Steps 2 and 3 never block the app and end with Got it. Skip tour on any step ends the whole tour. "Show the tour
 * again" (`startDesktopTour`) forgets the steps and opens step 1 again. `suppressed` (the SF_FIRST_TOUR=off test seam)
 * stops the tour from starting on its own; a replay still runs it.
 */
export function DesktopTourHost({
  app,
  language,
  ready = true,
  suppressed = false,
  delayMs = 500,
  videoSrc,
  onPickFiles,
  testId = "desktop-tour",
}: {
  app: DesktopTourApp;
  language: string;
  /** Home is on screen and laid out: step 1 may open. Steps 2 and 3 follow the app wherever the host is mounted. */
  ready?: boolean;
  suppressed?: boolean;
  delayMs?: number;
  /** The app's bundled drop video (a few seconds, muted, looping). */
  videoSrc: string;
  onPickFiles: () => Promise<boolean>;
  testId?: string;
}) {
  const [introOpen, setIntroOpen] = useState(false);
  const [armed, setArmed] = useState(!suppressed);
  const [step, setStep] = useState<"review" | "jobs" | null>(null);
  const scene = useTourScene();
  // Jobs listed when "Show the tour again" opened step 1: a count above it is a new job. On the first run every job is
  // the first import's (a setup's folder scan lists its job before step 1 could open), so it starts at none.
  const jobsBaseline = useRef<number | null>(0);

  useEffect(() => setArmed((current) => current || !suppressed), [suppressed]);

  const openIntro = useCallback(() => {
    if (takeDesktopTourRequest()) jobsBaseline.current = null;
    setStep(null);
    setArmed(true);
    setIntroOpen(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Peek, and take the request only as step 1 opens: React may mount the host twice (StrictMode), and the first
    // mount's cleanup cancels its timer, so taking it here would leave the second mount with nothing to open.
    if (!isDesktopTourRequested() && (suppressed || isDesktopTourStepSeen("intro"))) return;
    // An import that reached its review before the delay ran out (Parrot's setup scans the folders it was given)
    // already counts as the first one: step 1 stays closed.
    const timer = window.setTimeout(() => {
      if (!isDesktopTourRequested() && isDesktopTourStepSeen("intro")) return;
      openIntro();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [ready, suppressed, delayMs, openIntro]);

  useEffect(() => {
    if (!ready) return;
    window.addEventListener(DESKTOP_TOUR_START_EVENT, openIntro);
    return () => window.removeEventListener(DESKTOP_TOUR_START_EVENT, openIntro);
  }, [ready, openIntro]);

  const finishIntro = useCallback(() => {
    markDesktopTourStepSeen("intro");
    setIntroOpen(false);
  }, []);

  const skip = useCallback(() => {
    console.info("[desktop-tour] skipped");
    skipDesktopTour();
    setIntroOpen(false);
    setStep(null);
  }, []);

  // Steps 2 and 3 start from what the app shows, never from a button of the tour.
  useEffect(() => {
    if (jobsBaseline.current === null || scene.jobsCount < jobsBaseline.current) jobsBaseline.current = scene.jobsCount;
    if (!armed || introOpen) return;
    if (step === "review") {
      if (!scene.review) setStep(null);
      return;
    }
    if (step !== null) return;
    if (scene.review) {
      if (isDesktopTourStepSeen("review")) return;
      console.info("[desktop-tour] step 2: import review");
      // A real import is the first import even when step 1 never opened (an import started during Parrot's setup).
      markDesktopTourStepSeen("intro");
      markDesktopTourStepSeen("review");
      setStep("review");
      return;
    }
    // Step 3 follows step 2: a job listed before any import review (the setup's folder scan) or a panel opened before
    // it waits, and the job still counts once step 2 has been seen.
    if (!isDesktopTourStepSeen("review") || isDesktopTourStepSeen("jobs")) return;
    if (scene.panel || scene.jobsCount > jobsBaseline.current) {
      console.info(`[desktop-tour] step 3: ${scene.panel ? "jobs panel opened" : "first job"}`);
      markDesktopTourStepSeen("jobs");
      setStep("jobs");
    }
  }, [armed, introOpen, step, scene]);

  const done = useCallback(() => setStep(null), []);

  if (introOpen) {
    return (
      <DesktopTourIntro
        app={app}
        language={language}
        videoSrc={videoSrc}
        onPickFiles={onPickFiles}
        onImported={finishIntro}
        onSkip={skip}
        importShown={scene.review !== null || scene.otherDialog}
        testId={testId}
      />
    );
  }
  if (step === "review" && scene.review) {
    return createPortal(
      <TourCard
        step="review"
        language={language}
        titleKey={`${app}.review.title`}
        bodyKey={`${app}.review.body`}
        onSkip={skip}
        testId={testId}
        className="absolute bottom-24 right-6 z-10"
        action={gotItButton(language, done, testId)}
      />,
      scene.review,
    );
  }
  if (step === "jobs" && scene.panel) {
    return (
      <>
        {createPortal(
          <TourCard
            step="jobs"
            language={language}
            titleKey={`${app}.jobs.title`}
            bodyKey={`${app}.jobsPanel.body`}
            onSkip={skip}
            testId={testId}
            className="sticky bottom-0 mt-4 w-full"
            style={{ width: "auto" }}
            action={gotItButton(language, done, testId)}
          />,
          scene.panel,
        )}
        {createPortal(<TourRing element={scene.jobsButton} dim={false} testId={testId} />, document.body)}
      </>
    );
  }
  if (step === "jobs" && scene.jobsButton && !scene.otherDialog) {
    return <JobsButtonStep app={app} language={language} button={scene.jobsButton} onDone={done} onSkip={skip} testId={testId} />;
  }
  return null;
}
