import type { ReactNode } from "react";

type EmptyStateTextProps = {
  children: ReactNode;
  className?: string;
};

export const EmptyStateText = ({ children, className }: EmptyStateTextProps) => {
  return <p className={["text-xs text-[#8b949e]", className ?? ""].join(" ")}>{children}</p>;
};
