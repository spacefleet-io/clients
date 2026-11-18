import type { ReactNode } from "react";

type DesktopTopNavFrameProps = {
  brand: ReactNode;
  // Small lasting state signs (offline chip, "Syncing") beside the brand: inside the fixed bar, so they never push
  // the page down (UX-NOTICE-02). Shown at every window width.
  status?: ReactNode;
  desktopNav?: ReactNode;
  desktopActions?: ReactNode;
  mobileActions?: ReactNode;
  reserveHeight?: boolean;
  desktopLayout?: "centered" | "trailing" | "balanced";
};

export const DesktopTopNavFrame = ({
  brand,
  status,
  desktopNav,
  desktopActions,
  mobileActions,
  reserveHeight = true,
  desktopLayout = "centered",
}: DesktopTopNavFrameProps) => {
  const hasDesktopSlots = Boolean(desktopNav || desktopActions);
  // Balanced: brand | nav | actions in a grid whose side columns never shrink
  // below their content, so a long nav label (fr/nl/de) pushes the nav aside
  // instead of sliding under the actions; with room to spare the nav stays centred.
  const balancedGrid = hasDesktopSlots && desktopLayout === "balanced";
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 w-full border-b border-[#30363d] bg-[#0d1117]/85">
        <div
          className={
            balancedGrid
              ? "flex h-16 w-full items-center gap-3 px-8 md:grid md:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]"
              : "flex h-16 w-full items-center gap-3 px-8"
          }
        >
          {status ? (
            <div className="flex min-w-0 items-center gap-3">
              {brand}
              {status}
            </div>
          ) : (
            brand
          )}
          {hasDesktopSlots ? (
            desktopLayout === "trailing" ? (
              <div className="hidden md:ml-auto md:flex md:items-center md:gap-3">
                {desktopNav}
                {desktopActions}
              </div>
            ) : desktopLayout === "balanced" ? (
              <>
                <div className="hidden md:flex md:items-center">{desktopNav}</div>
                <div className="hidden md:flex md:items-center md:justify-end md:gap-3">{desktopActions}</div>
              </>
            ) : (
              <div className="hidden md:grid md:flex-1 md:grid-cols-[1fr_auto_1fr] md:items-center">
                <div />
                <div className="justify-self-center">{desktopNav}</div>
                <div className="justify-self-end">{desktopActions}</div>
              </div>
            )
          ) : (
            <div className="hidden md:flex md:flex-1" />
          )}
          {mobileActions ? <div className="ml-auto flex md:hidden items-center gap-2">{mobileActions}</div> : null}
        </div>
      </header>
      {reserveHeight ? <div className="h-16" /> : null}
    </>
  );
};
