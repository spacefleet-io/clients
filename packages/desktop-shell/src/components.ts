export type DesktopShellComponentBoundary = {
  id: string;
  description: string;
};

export const desktopShellComponents: DesktopShellComponentBoundary[] = [
  { id: "AccountStorageCard", description: "Shared storage usage display with per-app breakdown and upgrade CTA." },
  { id: "AuthCardLayout", description: "Shared card layout and visual skeleton for auth screens." },
  { id: "ApiHostSettingsButton", description: "Shared host settings trigger and dialog surface." },
  { id: "DesktopStartupPage", description: "Shared startup screen page shell for auth and onboarding flows." },
  { id: "DesktopStartupControls", description: "Shared top-right startup controls dock for language and host settings." },
  { id: "DesktopStartupCard", description: "Shared startup card shell for auth, verification, and library-key flows." },
  { id: "DesktopAuthForm", description: "Shared auth-form field, button, and prompt chrome for desktop apps." },
  { id: "DesktopAppTopNav", description: "Shared desktop app top-nav shell with brand, nav, and action slots." },
  { id: "DesktopTopNav", description: "Shared desktop top navigation frame." },
  { id: "DesktopTopNavActions", description: "Shared top-nav icon and text action shells." },
  { id: "DesktopTopNavStyles", description: "Shared top-nav spacing and typography helpers." },
  { id: "DesktopNotificationTray", description: "Shared right-side notifications tray shell for desktop apps." },
  { id: "DesktopJobsSheet", description: "Shared top-bar Jobs item (flask) and its right-side jobs panel, with filter chips and empty state." },
  { id: "DesktopJobCard", description: "Shared job cards inside the Jobs panel and a title's Jobs tab: group card, job rows, status pill, X/bin, progress, loading skeleton, background line (UX-JOBS-02)." },
  { id: "AnimatedDismissRow", description: "Shared list-row wrapper that animates removal with collapse + slide + fade so neighbours glide up smoothly." },
  { id: "DesktopWelcomeHero", description: "Shared widescreen empty-state welcome hero for desktop apps." },
  { id: "SyncBadgeSurface", description: "Shared sync health/status indicator shell." },
  { id: "NoticeSurface", description: "Shared notice banner for neutral/info/error states." },
  { id: "EmptyStateText", description: "Shared empty-state copy surface." },
  { id: "ShellErrorCard", description: "Shared shell-level error card surface with actions." },
  { id: "SignOutKeyCheck", description: "Shared saved-library-key question before the user's own Sign out (ACCT-DEV-03)." },
  { id: "PairWithPhone", description: "Shared 'Sign in with another device' screen: QR code, short code, countdown (ACCT-PAIR-01/05)." },
  { id: "DesktopPasswordReset", description: "Shared 'Forgot password?' link under the sign-in form and its reset dialog (ACCT-AUTH-05, ACCT-SIGNIN-05)." },
  { id: "ChoiceList", description: "Shared scrollable single-choice list with keyboard navigation (setup language picker)." },
  { id: "DesktopSettingsShell", description: "Shared Settings page: grouped, filterable category rail on the left and the open category on the right (UX-SET-01)." },
  { id: "CreditsPanel", description: "Shared Settings > About credits: outside data sources with their required logos and notices, from the metadata service's /credits (META-SRC-09)." },
  { id: "OpenSourceNotice", description: "Shared first line of each app's credits place: the GPL-3.0 notice and the link to the public source code (UX-SET-03)." },
  { id: "ErrorReportsLink", description: "Shared 'What's in a report?' link to the privacy policy's error-reports part (REL-LOG-06)." },
];

export {
  AccountStorageCard,
  type AccountStorageCardData,
  type RecomputeStrings,
  type RecomputeDryRunResult,
  type RecomputeRunResult,
} from "./components/account-storage-card";
export { AuthCardLayout } from "./components/auth-card-layout";
export { DesktopAppTopNav } from "./components/desktop-app-top-nav";
export { DesktopStartupControls } from "./components/desktop-startup-controls";
export { DesktopStartupCard } from "./components/desktop-startup-card";
export { DesktopStartupPage } from "./components/desktop-startup-page";
export {
  DesktopAuthPrimaryButton,
  DesktopAuthPrompt,
  desktopAuthInputClassName,
  desktopAuthPromptActionClassName,
  desktopAuthSignupButtonClassName,
  desktopAuthSignupAccentTextClassName,
} from "./components/desktop-auth-form";
export { DesktopTopNavFrame } from "./components/desktop-top-nav-frame";
export { DesktopTopNavIconAction, DesktopTopNavTextAction } from "./components/desktop-top-nav-actions";
export {
  desktopTopNavActiveIconClassName,
  desktopTopNavDisabledClassName,
  desktopTopNavIconActionClassName,
  desktopTopNavItemBaseClassName,
  desktopTopNavItemClassName,
  desktopTopNavTextActionBaseClassName,
  desktopTopNavTone,
} from "./components/desktop-top-nav-styles";
export { DesktopNotificationTray } from "./components/desktop-notification-tray";
export {
  DesktopJobsSheet,
  DesktopJobsFilterBar,
  DesktopJobsEmpty,
  DESKTOP_JOB_FILTERS,
  type DesktopJobFilter,
} from "./components/desktop-jobs-panel";
export {
  DesktopCompletedJobRow,
  DesktopJobActionButton,
  DesktopJobBucketHeader,
  DesktopJobGroupCard,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobStatusPill,
  DesktopJobsBackgroundLine,
  DesktopJobsLoadingSkeleton,
  DesktopJobsTabEmpty,
  type DesktopJobTone,
} from "./components/desktop-job-card";
export { NotificationTrayContent, type NotificationTrayLabels, type NotificationTrayContentProps } from "./components/desktop-notification-tray-content";
export {
  AnimatedDismissRow,
  useStaggeredDismiss,
  DISMISS_ANIMATION_MS,
} from "./components/animated-dismiss-row";
export { DesktopWelcomeHero } from "./components/desktop-welcome-hero";
export { SyncBannerSurface } from "./components/sync-banner-surface";
export { NoticeSurface, noticeSurfaceToneClass } from "./components/notice-surface";
export { EmptyStateText } from "./components/empty-state-text";
export { ShellErrorCard, shellErrorCardClassName } from "./components/shell-error-card";
export {
  ApiHostSettingsButton,
  formatActiveApiHostLabel,
  formatHostBadgeLabel,
} from "./components/api-host-settings-button";
export { PairDeviceDialog, type PairDeviceActions } from "./components/pair-device-dialog";
export {
  pairDeviceStrings,
  pairDeviceText,
  type PairDeviceKind,
  type PairDeviceStringKey,
} from "./components/pair-device-strings";
export { default as PairWithPhone, PAIRING_POLL_INTERVAL_MS, type PairWithPhoneActions } from "./components/pair-with-phone";
export { pairWithPhoneStrings, pairWithPhoneText, type PairWithPhoneStringKey } from "./components/pair-with-phone-strings";
export { DesktopForgotPasswordLink, DesktopPasswordResetDialog } from "./components/desktop-password-reset";
export { passwordResetStrings, passwordResetText, type PasswordResetStringKey } from "./components/password-reset-strings";
export {
  LibraryKeyStep,
  type LibraryKeyStepPairing,
  type LibraryKeyStepProps,
  type LibraryKeyTyped,
} from "./components/library-key-step";
export { libraryKeyEraseOutcomeOf, type LibraryKeyEraseOutcome } from "./libraryKeyErase";
export { libraryKeyStepText, type LibraryKeyStepStringKey } from "./components/library-key-step-strings";
export { ChoiceList, type ChoiceListOption } from "./components/choice-list";
export {
  DesktopSettingsShell,
  type DesktopSettingsGroup,
  type DesktopSettingsSection,
} from "./components/desktop-settings-shell";
export { CreditsPanel } from "./components/credits-panel";
export { OpenSourceNotice } from "./components/open-source-notice";
export { ErrorReportsLink } from "./components/error-reports-link";
