import * as React from "react";
import {
  crashAfterRetry,
  popupCrashNotice,
  renderErrorCopyFor,
  renderErrorWindowDetail,
  sessionReloadMarker,
  type RenderErrorCopy,
} from "@space/shared/renderError";
import { SPACE_APP_NAMES } from "@space/shared/appScope";
import type { SkyNebulaName } from "@space/shared/skyNebula";
import { reportCaughtError } from "@space/error-report/caught";

import { FloatingMascot, MASCOT_GLOW } from "./floating-mascot";
import { cn } from "./utils";

// The sky is drawn only on a crash: loaded then, so the star sky stays out of every app's startup chunk.
const LazyAppBackdrop = React.lazy(() => import("./app-backdrop"));

/**
 * Render crash isolation (UX-CRASH-01): one broken element blanks only itself. A `RenderBoundary` catches any render,
 * effect or update-loop error thrown below it (React routes errors along the component tree, so a boundary outside a
 * portal also catches what renders inside it) and shows a small fallback with one "Try again" button instead of
 * letting React unmount the whole app into a dark window.
 *
 * "Try again" (the only button, `retry`): the first press calls `onRetry` (the app clears or refetches the
 * data the part used) and mounts the part anew under a fresh key, so its component state is thrown away too. When the
 * same boundary throws again within a few seconds of that press, the retry could not work: the window reloads by
 * itself (`onReload`, else `window.location.reload()`), with no second notice and no extra click. A short-lived
 * marker in `sessionStorage` records that reload, so a crash that survives it shows the notice again and the next
 * press only retries: never a reload loop (`crashAfterRetry` in `@space/shared/renderError`).
 *
 * - `screen`: the app's last line of defence (around the whole tree): full window. It also shows the "closed" notice
 *   of a pop-up that a crash closed (`onDismiss`). With `brand` (the guard around the whole window) it is the sign-in
 *   screen's look: the star sky, the app's floating mascot and "Something went wrong. <App> needs to restart this
 *   screen.".
 * - `section`: a screen/route, a list or row, the player overlay: a small inline notice.
 * - `item`: one card or row of a long list (library grid and list, search results): a quiet "This item can't be
 *   shown." placeholder in its place, so the other items stay; no button (the same data would throw again).
 * - `overlay`: a layer drawn over the screen (the player): a small floating notice, so a crash inside a portal stays
 *   visible without covering the screen.
 * - with `onDismiss` (dialogs, sheets, menus): a crash closes the pop-up and the window guard says so.
 *
 * The copy comes from `@space/shared/renderError` (its translation files, UX-I18N-02), shared with the phone shell's
 * guard, so every app shows the same words; the language follows `<html lang>`, which each app's i18n sets, because
 * the outermost boundary sits above the apps' translation providers.
 */
export type RenderBoundaryVariant = "screen" | "section" | "overlay" | "item";

export const renderErrorCopy = (lang?: string | null): RenderErrorCopy =>
  renderErrorCopyFor(lang || (typeof document === "undefined" ? "" : document.documentElement.lang));

/** The app around a whole-window `screen` guard: its crash screen wears the sign-in screen's sky and mascot. */
export type RenderBoundaryBrand = {
  /** Names the app ("Badger needs to restart this screen."), and picks its mascot glow and nebula. */
  app: SkyNebulaName;
  /** The app's mascot picture, the sign-in screen's. */
  mascotSrc: string;
  /**
   * Set when nothing outside the guard draws the star sky (Badger desktop: its sky lives inside the screens): the crash
   * screen then draws the sky itself. Leave it off when the app mounts the sky outside the guard (Parrot, the web
   * players): it shows through the transparent crash screen, never twice.
   */
  drawSky?: boolean;
};

export type RenderBoundaryProps = {
  /** Names the guarded element in the log line, e.g. "route:/media-library" or "dialog". */
  name: string;
  variant?: RenderBoundaryVariant;
  /** A changed value clears a caught error, e.g. the route path, so navigating away recovers the screen. */
  resetKey?: unknown;
  /**
   * Called on "Try again" before the part is mounted anew: drop or refetch the cached data it rendered from (e.g. the
   * route's library data), so the retry does not render the same broken data again. When it returns a promise, the
   * part is mounted anew once it settles (the button is busy meanwhile), so the retry renders the fresh data.
   */
  onRetry?: () => void | Promise<unknown>;
  /** Reloads the window when a retry failed; defaults to `window.location.reload()`. */
  onReload?: () => void;
  /** Set on the guard around the whole window: the `screen` variant then shows the sky, mascot and app name. */
  brand?: RenderBoundaryBrand;
  /**
   * The guarded element is a pop-up (dialog, sheet, menu): a crash inside it closes it by calling this, draws nothing in
   * its place, and the app's `screen` guard shows "This window hit an error and was closed".
   */
  onDismiss?: () => void;
  className?: string;
  /**
   * The guarded element. Pass a function (`{() => page()}`) when the element is built by a plain function call in the
   * parent's render: the boundary then calls it below itself, so a throw while building it is caught here too instead
   * of crashing the parent.
   */
  children?: React.ReactNode | (() => React.ReactNode);
};

/** Calls a render function as its own component, below the boundary (a boundary never catches its own render). */
const RenderGuarded = ({ render }: { render: () => React.ReactNode }) => <>{render()}</>;

type RenderBoundaryState = { error: Error | null; generation: number; retrying: boolean };

/** Outlives `window.location.reload()`: the reload a failed retry made, so a crash after it never reloads again. */
const reloadMarker = sessionReloadMarker();

export class RenderBoundary extends React.Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { error: null, generation: 0, retrying: false };
  /** When the part was last mounted anew by "Try again"; a crash soon after it means the retry could not work. */
  private retriedAt: number | null = null;

  static getDerivedStateFromError(error: unknown): Partial<RenderBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`[render-boundary] ${this.props.name} caught a render error`, error, info.componentStack);
    // REL-LOG-06: a caught error never reaches the SDK's global handlers; send it while reporting is on.
    reportCaughtError(error, this.props.onDismiss ? "popup" : (this.props.variant ?? "section"));
    if (this.props.onDismiss) {
      console.info(`[render-boundary] ${this.props.name} closed`);
      popupCrashNotice.post(this.props.name);
      this.props.onDismiss();
      return;
    }
    const now = Date.now();
    const retriedAt = this.retriedAt;
    this.retriedAt = null;
    const next = crashAfterRetry({ retriedAt, now, marker: reloadMarker });
    console.info(
      `[render-boundary] ${this.props.name} crash after try again: ${next}`,
      retriedAt === null ? "(no try again pending)" : `(${now - retriedAt} ms after the press)`
    );
    if (next === "reload") this.reload();
  }

  componentDidUpdate(previous: RenderBoundaryProps): void {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) {
      this.retriedAt = null;
      this.setState({ error: null, retrying: false });
    }
  }

  /** "Try again": clear the app's data for this part (waiting for it when `onRetry` is async), then mount it anew. */
  private retry = () => {
    if (this.state.retrying) return;
    console.info(`[render-boundary] ${this.props.name} try again`);
    let pending: unknown;
    try {
      pending = this.props.onRetry?.();
    } catch (error) {
      console.error(`[render-boundary] ${this.props.name} onRetry failed`, error);
    }
    if (!(pending instanceof Promise)) {
      this.remount();
      return;
    }
    this.setState({ retrying: true });
    pending
      .catch((error: unknown) => console.error(`[render-boundary] ${this.props.name} onRetry failed`, error))
      // No "still mounted?" flag: StrictMode unmounts and mounts the same instance again, which left such a flag set
      // for good; React ignores a setState after a real unmount.
      .then(() => {
        console.info(`[render-boundary] ${this.props.name} data refreshed: mounting anew`);
        this.remount();
      });
  };

  /** Mounts the part anew under a fresh key; its component state is thrown away. */
  private remount = () => {
    this.retriedAt = Date.now();
    this.setState((state) => ({ error: null, retrying: false, generation: state.generation + 1 }));
  };

  /** The retry failed again right away: reload the window, the stronger fix, without asking. */
  private reload = () => {
    console.info(`[render-boundary] ${this.props.name} still failing after try again: reloading the window`);
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.error) {
      const { children } = this.props;
      const guarded = typeof children === "function" ? <RenderGuarded render={children} /> : children;
      // A new key on "Try again" throws away every component state below and mounts the part anew.
      const content = <React.Fragment key={this.state.generation}>{guarded}</React.Fragment>;
      // The window guard also shows the notice of a pop-up that a crash closed.
      return this.props.variant === "screen" ? (
        <>
          {content}
          <PopupCrashNotice />
        </>
      ) : (
        content
      );
    }
    if (this.props.onDismiss) return null;
    const variant = this.props.variant ?? "section";
    const copy = renderErrorCopy();
    if (variant === "item") {
      return (
        <div
          role="note"
          data-testid="render-boundary-item"
          data-boundary={this.props.name}
          className={cn(
            "flex min-h-12 items-center justify-center rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground",
            this.props.className
          )}
        >
          {copy.itemFailed}
        </div>
      );
    }
    const buttonClass =
      "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    if (variant === "screen") {
      const { brand } = this.props;
      return (
        <div
          role="alert"
          data-testid="render-boundary-screen"
          data-boundary={this.props.name}
          className={cn("flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground", this.props.className)}
        >
          {brand?.drawSky ? (
            <React.Suspense fallback={null}>
              <LazyAppBackdrop nebula={brand.app} />
            </React.Suspense>
          ) : null}
          {brand ? (
            <FloatingMascot src={brand.mascotSrc} glowClassName={MASCOT_GLOW[brand.app]} className="relative z-10 mb-2" testId="render-boundary-mascot" />
          ) : null}
          <p className="relative z-10 text-lg font-semibold">{copy.message}</p>
          <p className="relative z-10 max-w-md text-sm text-muted-foreground">
            {brand ? renderErrorWindowDetail(copy, SPACE_APP_NAMES[brand.app]) : copy.detail}
          </p>
          {/* One button: "Try again" retries, and reloads the window by itself when the retry fails again. */}
          <div className="relative z-10 flex gap-3">
            <button
              type="button"
              className={cn(buttonClass, "bg-primary text-primary-foreground hover:bg-primary/90")}
              onClick={this.retry}
              disabled={this.state.retrying}
              aria-busy={this.state.retrying}
            >
              {copy.retry}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        role="alert"
        data-testid={`render-boundary-${variant}`}
        data-boundary={this.props.name}
        className={cn(
          "flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground",
          variant === "overlay" && "fixed bottom-6 left-1/2 z-[1000] -translate-x-1/2 shadow-lg",
          this.props.className
        )}
      >
        <span>{copy.message}</span>
        <button type="button" className={buttonClass} onClick={this.retry} disabled={this.state.retrying} aria-busy={this.state.retrying}>
          {copy.retry}
        </button>
      </div>
    );
  }
}

/**
 * Puts each child of a list or grid in its own `item` guard (UX-CRASH-01): one card or row that throws shows the
 * placeholder in its place and the others stay. Each child keeps its key; the guard is named `<name>:<key>`.
 */
export function GuardedItems({ name, children, className }: { name: string; children: React.ReactNode; className?: string }) {
  return (
    <>
      {React.Children.map(children, (child) => {
        const key = React.isValidElement(child) && child.key !== null ? `${name}:${child.key}` : name;
        return (
          <RenderBoundary name={key} variant="item" className={className}>
            {child}
          </RenderBoundary>
        );
      })}
    </>
  );
}

/** The window guard's notice after a crash closed a pop-up: the reason the dialog vanished, until dismissed. */
const PopupCrashNotice = () => {
  const closed = React.useSyncExternalStore(popupCrashNotice.subscribe, popupCrashNotice.current, popupCrashNotice.current);
  if (closed === null) return null;
  const copy = renderErrorCopy();
  return (
    <div
      role="alert"
      data-testid="render-boundary-popup-closed"
      data-boundary={closed}
      className="fixed bottom-6 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg"
    >
      <span>
        <span className="font-semibold">{copy.message}</span> {copy.popupClosed}
      </span>
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={popupCrashNotice.dismiss}
      >
        {copy.dismiss}
      </button>
    </div>
  );
};
