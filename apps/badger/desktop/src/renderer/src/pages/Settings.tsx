import SettingsLayout from "../components/settings/SettingsLayout";

/**
 * The unified settings surface. Both the former Settings page and the former
 * Account page now render the same two-pane shell; `/settings` lands on the
 * General section. See components/settings/* for the section breakdown.
 */
export default function Settings() {
  return <SettingsLayout />;
}
