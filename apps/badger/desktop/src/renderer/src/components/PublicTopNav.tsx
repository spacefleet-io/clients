import { useTranslation } from "react-i18next";
import iconPng from "@/assets/icon.png";
import { AppBrand } from "@space/ui";
import { DesktopTopNavFrame } from "@space/desktop-shell/components";

export default function PublicTopNav() {
  const { t } = useTranslation();
  const iconSrc = iconPng;

  return (
    <DesktopTopNavFrame
      brand={<AppBrand logoSrc={iconSrc} logoAlt={t("brand.app")} title={t("brand.app")} />}
    />
  );
}
