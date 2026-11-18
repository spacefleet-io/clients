import { useTranslation } from "react-i18next";
import { setApiBaseUrl } from "@space/shared/api";
import { ApiHostSettingsButton } from "@space/desktop-shell/components";
import { currentDesktopBuildEnv, isDesktopDevBuild, type DesktopBuildEnv } from "../../../shared/devBuild";

/**
 * The server picker on the sign-in and sign-up screens (ACCT-AUTH-09): only a development build has it. A release
 * build trusts the production ticket key only (META-ANON-07), so pointing it at another server would silently lose
 * every title and poster; it renders nothing and the main process ignores any stored custom address.
 */
export default function AuthApiHostButton({ buildEnv = currentDesktopBuildEnv() }: { buildEnv?: DesktopBuildEnv }) {
  if (!isDesktopDevBuild(buildEnv)) return null;
  return <AuthApiHostPicker />;
}

function AuthApiHostPicker() {
  const { t } = useTranslation();

  return (
    <ApiHostSettingsButton
      bridge={{
        apiHost: {
          get: () => window.sf?.apiHost?.get?.() ?? Promise.reject(new Error("api_host_unavailable")),
          set: (input) => window.sf?.apiHost?.set?.(input) ?? Promise.reject(new Error("api_host_unavailable")),
        },
      }}
      labels={{
        button: t("authApiHost.button"),
        title: t("authApiHost.title"),
        subtitle: t("authApiHost.subtitle"),
        label: t("authApiHost.label"),
        placeholder: t("authApiHost.placeholder"),
        hint: t("authApiHost.hint"),
        useDefault: t("authApiHost.useDefault"),
        save: t("authApiHost.save"),
        saving: t("authApiHost.saving"),
        error: t("authApiHost.error"),
        apiLabel: t("authApiHost.apiLabel"),
        customBadge: t("authApiHost.customBadge"),
        defaultBadge: t("authApiHost.defaultBadge"),
      }}
      className="border-[#30363d] text-[#8b949e] hover:text-white hover:bg-[#161b22]"
      onApiHostApplied={setApiBaseUrl}
    />
  );
}
