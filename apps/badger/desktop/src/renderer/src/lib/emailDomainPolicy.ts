import { disposableEmailCheck } from "@space/shared/signUp";

export const isDisposableEmailDomain = disposableEmailCheck(
  import.meta.env.VITE_EMAIL_DOMAIN_ALLOWLIST,
  import.meta.env.VITE_DISPOSABLE_EMAIL_DOMAINS,
);
