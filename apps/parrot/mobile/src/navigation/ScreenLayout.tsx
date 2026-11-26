import React from "react";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileSkyScreenLayout, type MobileSkyScreenNavigation } from "@space/mobile-shell/components";
import { UnpaidScreenLayout } from "@space/mobile-shell/unpaid-access-sign";
import { useSession } from "../state/session";

/**
 * What the phone's navigator puts around every screen (`screenLayout`):
 * - UX-SKY-04: every screen stands on the sky (a screen with its own `ParrotSky` takes it over); the player paints its
 *   own sky and slides as a whole when dragged down (UX-SHEET-01), so none under it.
 * - ACCT-UNPAID-05, UX-NOTICE-08: the unpaid sign on every page pushed over the tabs or opened from a link (an album,
 *   an artist, a playlist, pairing), floating at the bottom so no screen moves. The tab pages ("Main") carry it on
 *   their tab bar instead (MainScreen); the player shows none.
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
  const { access } = useSession();
  const playing = route.name === "Player";
  return (
    <MobileSkyScreenLayout navigation={navigation} sky={!playing}>
      <UnpaidScreenLayout access={access} playing={playing} onTabBar={route.name === "Main"}>
        <MobileRenderBoundary name={`screen:${route.name}`} resetKey={route.key}>
          {children}
        </MobileRenderBoundary>
      </UnpaidScreenLayout>
    </MobileSkyScreenLayout>
  );
};
