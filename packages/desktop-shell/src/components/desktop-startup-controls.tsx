import type { ReactNode } from "react";

type DesktopStartupControlsProps = {
  children: ReactNode;
};

export const DesktopStartupControls = ({ children }: DesktopStartupControlsProps) => {
  return <div className="fixed right-8 top-20 z-50 flex items-center gap-2">{children}</div>;
};
