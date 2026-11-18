import type { ReactNode } from "react";

type SyncBannerSurfaceProps = {
  visible: boolean;
  icon?: ReactNode;
  message: ReactNode;
};

export const SyncBannerSurface = ({ visible, icon, message }: SyncBannerSurfaceProps) => {
  if (!visible) {
    return null;
  }

  return (
    <div className="border-b border-[#30363d] bg-[#0b1624]/90">
      <div className="container flex items-center gap-2 px-4 py-2 text-xs text-[#8b949e]">
        {icon}
        <span>{message}</span>
      </div>
    </div>
  );
};
