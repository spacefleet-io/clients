/**
 * Puts the "First setup" flow in front of the app on a computer that has not
 * answered yet (#25): the flow replaces the app until the user finishes, then
 * lands on Home. Mounted by App.tsx around AuthenticatedApp (inside the
 * signed-in route), lazy so none of it sits in the entry chunk.
 *
 * The library-key step comes first: while it is not acknowledged the app is
 * rendered as usual (it redirects to /onboarding/key) and the check repeats on
 * every route change until the key is acknowledged. The key was then "Step 1",
 * so these questions count on from 2 (UX-SETUP-08).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import FirstSetup from "./FirstSetup";
import { loadFirstSetup, type FirstSetupDevice, type FirstSetupStep } from "./firstSetupSteps";
import { rendererLogger } from "@/logger";
import { markSetupLanguageChosen } from "@/lib/setupLanguage";
import { useSetupRunState } from "@/lib/titleLanguageSetup";

const log = rendererLogger.child({ scope: "first-setup" });

const KEY_ROUTE = "/onboarding/key";

type GateState =
  | { kind: "checking" }
  | { kind: "pass"; keyPending: boolean }
  | { kind: "setup"; device: FirstSetupDevice; steps: FirstSetupStep[] };

export default function FirstSetupGate({ children, loadingFallback }: { children: ReactNode; loadingFallback: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<GateState>({ kind: "checking" });
  // The key step was shown (and counted) in this run of the setup.
  const keyCounted = useRef(false);
  // ACCT-PROF-03: the title question (in the app, once the library is open) is step 2, right after the key; this
  // computer's questions wait for it and count on after it.
  const setupRun = useSetupRunState();

  // Signed in: this computer is past setup step 0, so a later sign-out opens on the sign-in, not the language.
  useEffect(() => markSetupLanguageChosen(), []);

  // Nothing left to ask (flow open, or everything answered): stop re-checking on route changes.
  const settled = state.kind === "setup" || (state.kind === "pass" && !state.keyPending);

  useEffect(() => {
    // On the library key page nothing is asked; the check runs when the user leaves it.
    if (settled || pathname === KEY_ROUTE) return;
    let cancelled = false;
    loadFirstSetup()
      .then((result) => {
        if (cancelled) return;
        if (result.status === "deferred") keyCounted.current = result.openSteps > 0;
        if (result.status === "needed") setState({ kind: "setup", device: result.device, steps: result.steps });
        else setState({ kind: "pass", keyPending: result.status === "deferred" });
      })
      .catch((err: unknown) => {
        // Never block the app on an unreadable setting: main applies the recommendation until answered.
        log.error({ err: String(err) }, "[first-setup] could not read this computer's settings");
        if (!cancelled) setState({ kind: "pass", keyPending: false });
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, settled]);

  if (state.kind === "checking" && pathname !== KEY_ROUTE) return <>{loadingFallback}</>;
  if (state.kind === "setup" && setupRun.waiting) return <>{children}</>;
  if (state.kind === "setup") {
    return (
      <FirstSetup
        device={state.device}
        steps={state.steps}
        stepOffset={setupRun.stepsBefore ?? (keyCounted.current ? 1 : 0)}
        onDone={() => {
          setState({ kind: "pass", keyPending: false });
          navigate("/home", { replace: true });
        }}
      />
    );
  }
  return <>{children}</>;
}
