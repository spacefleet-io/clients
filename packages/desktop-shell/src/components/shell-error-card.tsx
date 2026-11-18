import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@space/ui";

export const shellErrorCardClassName = () => "space-panel text-white backdrop-blur-xl";

type ShellErrorCardProps = {
  title: ReactNode;
  message: ReactNode;
  actions?: ReactNode;
};

export const ShellErrorCard = ({ title, message, actions }: ShellErrorCardProps) => {
  return (
    <Card className={shellErrorCardClassName()}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-[#8b949e]">{message}</CardDescription>
      </CardHeader>
      {actions ? <CardContent className="flex flex-wrap gap-2">{actions}</CardContent> : null}
    </Card>
  );
};
