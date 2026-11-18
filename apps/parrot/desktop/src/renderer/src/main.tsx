import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppBackdrop from "@space/ui/app-backdrop";
import App from "./App";
import { applyErrorReports } from "./errorReports";
// The fonts load through Vite, not through styles.css: @tailwindcss/postcss inlines a CSS @import without rebasing
// its relative url()s, so the font files were never emitted and every heading fell back to a serif.
import "@space/ui/styles/fleet-fonts.css";
import "./styles.css";
import { RenderBoundary } from "@space/ui/render-boundary";
import mascotUrl from "@space/parrot-core/mascot.webp";
import { applyStorageUnitBase } from "@space/desktop-shell/storage-units";

// REL-LOG-06: this window reports errors only if the user opted in (answer kept by main). The SDK adapter is loaded
// on demand, so nothing is fetched for a user who said no; the boot never holds up the first render.
void applyErrorReports();

// STOR-UNIT-01: storage figures follow this computer's file manager; main worked the base out, set it before any
// component formats a size.
applyStorageUnitBase(window.parrot.storageUnitBase);

// The star sky (UX-SKY-01) is mounted once here, so setup, sign-in and the library all show it with Parrot's green
// nebula (UX-SKY-03). The page sits in a positioned layer above it.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppBackdrop nebula="parrot" />
    <div className="relative z-10">
      {/* UX-CRASH-01: a render crash shows the sign-in screen's sky (the one above) and mascot with one "Try again"
          button, never a dark window. */}
      <RenderBoundary name="app" variant="screen" className="bg-transparent" brand={{ app: "parrot", mascotSrc: mascotUrl }}>
        <App />
      </RenderBoundary>
    </div>
  </StrictMode>
);
