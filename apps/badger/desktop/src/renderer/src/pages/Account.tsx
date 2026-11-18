import SettingsLayout from "../components/settings/SettingsLayout";

/**
 * `/account` is now a deep-link into the unified settings surface: it renders
 * the same shell as `/settings` but lands on the Account & Plan section. The
 * former account/subscription/security logic lives in
 * components/settings/sections/{AccountSection,SecuritySection}.
 */
export default function Account() {
  return <SettingsLayout defaultSection="account" />;
}
