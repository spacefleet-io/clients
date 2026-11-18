import { checkSignUpInput, type SignUpInputProblem } from "@space/shared/signUp";
import { isDisposableEmailDomain } from "@/lib/emailDomainPolicy";

export type DesktopSignupValidationError = `signup.errors.${SignUpInputProblem}`;

/** The shared sign-up checks (`@space/shared/signUp`, also used by Parrot desktop), as Badger's translation keys. */
export const validateDesktopSignupInput = (
  email: string,
  password: string,
  confirm: string,
  isDisposableDomainFn: (value: string) => boolean = isDisposableEmailDomain
): DesktopSignupValidationError | null => {
  const problem = checkSignUpInput(email, password, confirm, isDisposableDomainFn);
  return problem ? `signup.errors.${problem}` : null;
};
