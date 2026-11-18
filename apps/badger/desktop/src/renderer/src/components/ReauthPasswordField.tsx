import { useTranslation } from "react-i18next";
import { Input, Label } from "@space/ui";
import { useHasPassword } from "@/auth";

/**
 * ACCT-AUTH-04: the password field of a re-check (account and library changes). An account without a password has none to
 * type, so in its place it reads that a code confirms it is you: the form's first submit then asks the API, which
 * emails the code (or wants the authenticator code) and the form shows its code field.
 */
export default function ReauthPasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const hasPassword = useHasPassword();
  if (!hasPassword) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${id}-no-password`}>
        {t("account.security.noPasswordHint")}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="current-password"
        disabled={disabled}
        autoFocus={autoFocus}
      />
    </div>
  );
}
