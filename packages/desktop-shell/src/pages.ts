export type DesktopShellPageBoundary = {
  id: string;
  description: string;
};

export const desktopShellPages: DesktopShellPageBoundary[] = [
  { id: "LoginPage", description: "Shared login flow container." },
  { id: "SignupPage", description: "Shared signup flow container." },
  { id: "VerifyEmailPage", description: "Shared verify-email container." },
  { id: "PasswordResetDialog", description: "Shared reset-password flow container." },
];
