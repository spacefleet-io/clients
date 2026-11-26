import React from "react";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileSkyScreenLayout, type MobileSkyScreenNavigation } from "@space/mobile-shell/components";
import { UnpaidScreenLayout } from "@space/mobile-shell/unpaid-access-sign";
import { useTvScale } from "@space/mobile-shell/tv/tvScale";
import { useAuth } from "../store/auth";
import { IS_TV } from "../tv/lib/tvRuntime";

/**
 * What the navigator puts around every screen (`screenLayout`):
 * - UX-SKY-04: the desktop's sky, except under the phone's details sheet (it shows the page below through its scrim
 *   and draws its own) and the player (black behind the video).
 * - ACCT-UNPAID-05, UX-NOTICE-08: the unpaid sign on every screen pushed over the tabs or opened from a link (a film,
 *   a playlist, pairing), floating at the bottom on the phone and under the top bar on the TV, so no screen moves.
 *   The phone's tab pages ("Main") carry it on their tab bar instead (MainShellScreen); the player shows none.
 * - UX-CRASH-01: a screen that throws shows Retry in its place; the rest of the app keeps running.
 */
export const ScreenLayout = ({
  route,
  navigation,
  children,
}: {
  route: { name: string; key: string };
  navigation: MobileSkyScreenNavigation;
  children: React.ReactNode;
}) => {
  const { user } = useAuth();
  const scale = useTvScale();
  const playing = route.name === "Player";
  return (
    <MobileSkyScreenLayout navigation={navigation} sky={!(playing || (route.name === "MediaDetails" && !IS_TV))}>
      <UnpaidScreenLayout
        access={user?.access}
        playing={playing}
        onTabBar={route.name === "Main"}
        tv={IS_TV}
        scale={IS_TV ? scale : 1}
      >
        <MobileRenderBoundary name={`screen:${route.name}`} resetKey={route.key}>
          {children}
        </MobileRenderBoundary>
      </UnpaidScreenLayout>
    </MobileSkyScreenLayout>
  );
};
