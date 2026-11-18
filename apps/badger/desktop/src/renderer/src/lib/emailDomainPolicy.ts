import { evaluateEmailDomainAgainstSets, parseDomainSet, splitDomainList } from "@space/shared";

export const isDisposableEmailDomain = (
  email: string,
  options?: {
    denySet?: Set<string>;
    allowSet?: Set<string>;
  }
) => {
  const allowSet = options?.allowSet ?? parseDomainSet(splitDomainList(import.meta.env.VITE_EMAIL_DOMAIN_ALLOWLIST));
  const denySet = options?.denySet ?? parseDomainSet(splitDomainList(import.meta.env.VITE_DISPOSABLE_EMAIL_DOMAINS));
  const decision = evaluateEmailDomainAgainstSets(email, {
    allowSet,
    denySet,
    upstreamSet: new Set<string>(),
  });
  return !decision.allowed;
};
