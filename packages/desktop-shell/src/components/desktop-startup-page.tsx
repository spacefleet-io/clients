import type { ReactNode } from "react";
import AppBackdrop from "@space/ui/app-backdrop";
import type { SkyNebulaName } from "@space/shared/skyNebula";

type DesktopStartupPageProps = {
  topNav?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
  mainClassName?: string;
  showBackdrop?: boolean;
  /** The app's nebula under the stars (UX-SKY-03). */
  nebula?: SkyNebulaName;
};

export const DesktopStartupPage = ({
  topNav,
  controls,
  children,
  mainClassName,
  showBackdrop = true,
  nebula,
}: DesktopStartupPageProps) => {
  const classes = [
    "container",
    "flex",
    "min-h-[calc(100vh-4rem)]",
    "items-center",
    "justify-center",
    "py-0",
    "relative",
    "z-10",
    mainClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="min-h-screen">
      {showBackdrop ? <AppBackdrop nebula={nebula} /> : null}
      {topNav}
      {controls}
      <main className={classes}>{children}</main>
    </div>
  );
};
