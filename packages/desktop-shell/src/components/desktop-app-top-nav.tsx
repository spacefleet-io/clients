import type { ReactNode } from "react";
import { AppBrand } from "@space/ui";
import { DesktopTopNavFrame } from "./desktop-top-nav-frame";

type DesktopAppTopNavProps = {
  logoSrc: string;
  logoAlt: string;
  title: string;
  status?: ReactNode;
  desktopNav?: ReactNode;
  desktopLayout?: "centered" | "trailing" | "balanced";
  leadingActions?: ReactNode;
  notificationAction?: ReactNode;
  accountAction?: ReactNode;
  signOutAction?: ReactNode;
  mobileActions?: ReactNode;
  reserveHeight?: boolean;
};

export function DesktopAppTopNav({
  logoSrc,
  logoAlt,
  title,
  status,
  desktopNav,
  desktopLayout = "balanced",
  leadingActions,
  notificationAction,
  accountAction,
  signOutAction,
  mobileActions,
  reserveHeight = true,
}: DesktopAppTopNavProps) {
  const hasActions = Boolean(leadingActions || notificationAction || accountAction || signOutAction);

  return (
    <DesktopTopNavFrame
      desktopLayout={desktopLayout}
      reserveHeight={reserveHeight}
      brand={<AppBrand logoSrc={logoSrc} logoAlt={logoAlt} title={title} />}
      status={status}
      desktopNav={desktopNav}
      desktopActions={
        hasActions ? (
          <div className="flex items-center gap-2">
            {leadingActions}
            {notificationAction}
            {accountAction}
            {signOutAction}
          </div>
        ) : null
      }
      mobileActions={mobileActions}
    />
  );
}
