import { lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth";
import { useProfiles } from "@/lib/profileStore";
import { LoadingScreen } from "@/components/LoadingScreen";
import TitleLanguageGate from "./TitleLanguageGate";

// Shown once per start (and per switch), so it stays out of the eager AuthenticatedApp chunk (renderer chunk budget).
const WhoIsWatching = lazy(() => import("./WhoIsWatching"));

const Loading = () => {
  const { t } = useTranslation();
  return <LoadingScreen label={t("app.loading")} />;
};

/**
 * UX-PROF-01 / UX-PROF-02: the signed-in app opens only once a profile is chosen. "Who's watching?" covers everything
 * while the account has several profiles and none is picked yet (every start, or after "Switch profile"); an account
 * with one profile goes straight in. While the first list of this account is still on its way, nothing is shown. A
 * profile that must still answer "How should titles appear?" (ACCT-PROF-03) is asked right after it is picked.
 */
export default function ProfileGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const snapshot = useProfiles();
  if (!user) return <>{children}</>;
  if (snapshot.userId !== user.id || snapshot.status !== "ready") return <Loading />;
  if (snapshot.needsChoice) {
    return (
      <Suspense fallback={<Loading />}>
        <WhoIsWatching />
      </Suspense>
    );
  }
  return <TitleLanguageGate>{children}</TitleLanguageGate>;
}
