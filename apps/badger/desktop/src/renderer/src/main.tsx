// Must stay the first import: it starts the active locale fetch before the rest
// of the entry evaluates (see i18n/boot.ts).
import { i18nReady } from "./i18n/boot";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RenderBoundary } from "@space/ui/render-boundary";
import mascotUrl from "./assets/mascot.webp";
// The fleet's UI fonts, shared with Parrot (`@space/ui`). They load through Vite, not through styles.css:
// @tailwindcss/postcss inlines a CSS @import without rebasing its relative url()s, so the font files would not ship.
import "@space/ui/styles/fleet-fonts.css";
import "./styles.css";
import { applyTheme, getInitialTheme } from "./theme";
import { hydrateSessionFromMain } from "./lib/sessionMirror";
import { setUiLanguage } from "./i18n";
import { loadClientConfig, subscribeClientConfig } from "./lib/config";
import { rendererLogger } from "./logger";
import { applyStorageUnitBase } from "@space/desktop-shell/storage-units";

// STOR-UNIT-01: storage figures follow this computer's file manager; main worked the base out, set it before any
// component formats a size.
applyStorageUnitBase(window.sf?.storageUnitBase);

// Ultimate-suite test seam (SF_E2E_PERF=1). Loaded on demand so the probe stays
// out of the startup entry chunk for every real user (issue #25: it was ~4.4 KiB
// of the entry). Its observers use `buffered: true`, so frames and input events
// from before the import resolves are still delivered.
if (window.sf?.e2ePerfEnabled === true) {
  void import("./lib/e2ePerfProbe")
    .then(({ installRendererPerfProbe }) => installRendererPerfProbe(true))
    .catch((err: unknown) =>
      rendererLogger
        .child({ scope: "e2e-perf-probe" })
        .error({ err: String(err) }, "[e2e-perf-probe] failed to load renderer perf probe"),
    );
}

// #25: refill session keys Chromium's localStorage lost (abrupt kill / crash)
// from the main-process copy BEFORE anything reads them (AuthProvider's
// useState initializers run on the first render).
hydrateSessionFromMain();

// REL-LOG-06: error reports start only if the user opted in (answer kept by main). Loaded on
// demand so the entry chunk carries none of it; nothing is fetched for a user who said no.
if (window.sf?.errorReports) {
  void import("./lib/errorReports")
    .then(({ bootErrorReports }) => bootErrorReports())
    .catch((err: unknown) =>
      rendererLogger.child({ scope: "error-report" }).error({ err: String(err) }, "[error-report] failed to load; reporting stays off"),
    );
}

applyTheme(getInitialTheme());

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {/* UX-CRASH-01: a render crash shows the sign-in screen's sky and mascot with one "Try again" button, never a dark
          window. The sky lives inside the screens here, so the crash screen draws its own. */}
      <RenderBoundary name="app" variant="screen" brand={{ app: "badger", mascotSrc: mascotUrl, drawSky: true }}>
        <App />
      </RenderBoundary>
    </React.StrictMode>
  );
};

// Only the active locale is loaded before the first render, so FR users get FR
// on first paint with no flash of raw keys; the other locale loads on switch.
void i18nReady
  .catch((err: unknown) =>
    rendererLogger
      .child({ scope: "i18n" })
      .error({ err: String(err) }, "[i18n] failed to initialise active locale; rendering anyway"),
  )
  .finally(() => {
    subscribeClientConfig(() => void setUiLanguage(loadClientConfig().uiLanguage));
    renderApp();
  });
