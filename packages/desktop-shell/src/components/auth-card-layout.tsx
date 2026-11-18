import type { ReactNode } from "react";
import { DesktopStartupCard } from "./desktop-startup-card";

type AuthCardLayoutProps = {
  subtitle: ReactNode;
  mascotSrc: string;
  mascotAlt: string;
  children: ReactNode;
  mascotGlowClassName?: string;
};

export const AuthCardLayout = ({
  subtitle,
  mascotSrc,
  mascotAlt,
  children,
  mascotGlowClassName,
}: AuthCardLayoutProps) => {
  return (
    <DesktopStartupCard
      eyebrow={subtitle}
      mascotSrc={mascotSrc}
      mascotAlt={mascotAlt}
      mascotGlowClassName={mascotGlowClassName}
    >
      {children}
    </DesktopStartupCard>
  );
};
