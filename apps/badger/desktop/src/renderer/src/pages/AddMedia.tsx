import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import TopNav from "@/components/TopNav";
import { useAuth } from "@/auth";
import { useIngestion } from "@/lib/ingestionContext";

export default function AddMedia() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { openIngestion } = useIngestion();

  useEffect(() => {
    if (!user) return;
    openIngestion();
    navigate("/media-library", { replace: true });
  }, [navigate, openIngestion, user]);

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen">
      <TopNav />
      <main className="container py-10 space-y-8">
        <div className="text-sm text-muted-foreground">{t("addMedia.openingImport")}</div>
      </main>
    </div>
  );
}
