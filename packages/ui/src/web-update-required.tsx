import * as React from "react";
import { getAppUpdateRequired, onAppUpdateRequired } from "@space/shared/appVersion";
import { webUpdateCopyFor } from "@space/shared/webUpdate";

import { FloatingMascot, MASCOT_GLOW } from "./floating-mascot";
import { cn } from "./utils";

const subscribe = (onChange: () => void) => onAppUpdateRequired(() => onChange());
const noRefusal = () => null;

/** The refusal ("please update") any API call of this page got, or null; re-renders once it comes. */
export const useWebUpdateRequired = () => React.useSyncExternalStore(subscribe, getAppUpdateRequired, noRefusal);

/**
 * Reloads the whole tab. A web player runs framed by the website (WEB-DASH-02, same origin), so the website reloads
 * too and both come back as the new build; a player opened on its own (or framed cross-origin) reloads itself.
 */
export const reloadWebTab = (win: Window = window) => {
  try {
    if (win.top && win.top !== win) {
      win.top.location.reload();
      return;
    }
  } catch {
    // A cross-origin top refuses access: reload this page.
  }
  win.location.reload();
};

/** The players with a web build, the apps a mascot glow exists for. */
type WebPlayerApp = keyof typeof MASCOT_GLOW;

type WebUpdateRequiredProps = {
  app: WebPlayerApp;
  mascotSrc: string;
  /** The page language; `<html lang>` by default (the player keeps it in step with its UI language). */
  lang?: string;
  onReload?: () => void;
};

/**
 * REL-CD-29 for a browser tab: once the API refuses this page's build ("please update"), the page is dimmed under a
 * notice with the app's floating mascot, "SpaceFleet has been updated. Reload to continue" and one Reload button
 * (Chris 2026-11-18, option (a)). Nothing to install: the new build is what the website already serves. Drawn over
 * whatever screen is open, sign-in included; renders nothing until a refusal.
 */
export const WebUpdateRequired = ({ app, mascotSrc, lang, onReload = reloadWebTab }: WebUpdateRequiredProps) => {
  const refusal = useWebUpdateRequired();
  if (!refusal) return null;
  const copy = webUpdateCopyFor(lang ?? (typeof document === "undefined" ? undefined : document.documentElement.lang));
  return <WebUpdateRequiredNotice app={app} mascotSrc={mascotSrc} title={copy.title} reload={copy.reload} onReload={onReload} />;
};

type NoticeProps = { app: WebPlayerApp; mascotSrc: string; title: string; reload: string; onReload: () => void };

export const WebUpdateRequiredNotice = ({ app, mascotSrc, title, reload, onReload }: NoticeProps) => (
  <div
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="web-update-required-title"
    data-testid="web-update-required"
    className="fixed inset-0 z-[2000] flex flex-col items-center justify-center gap-6 bg-black/70 p-8 text-center text-foreground backdrop-blur-sm"
  >
    <FloatingMascot src={mascotSrc} glowClassName={MASCOT_GLOW[app]} testId="web-update-required-mascot" />
    <h2 id="web-update-required-title" className="font-display max-w-md text-lg font-semibold">
      {title}
    </h2>
    <button
      type="button"
      autoFocus
      onClick={onReload}
      className={cn(
        "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {reload}
    </button>
  </div>
);
