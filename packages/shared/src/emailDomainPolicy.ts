export type EmailDomainBlockSource = "local_allow" | "local_deny" | "upstream";

export type EmailDomainDecision = {
  allowed: boolean;
  reason?: "disposable_domain";
  source?: EmailDomainBlockSource;
  matchedDomain?: string;
  normalizedDomain?: string;
};

export const normalizeDomain = (input: string) => input.trim().toLowerCase().replace(/\.+$/, "");

export const splitDomainList = (value?: string | null) =>
  String(value ?? "")
    .split(/[,\n;]/)
    .map((entry) => normalizeDomain(entry))
    .filter(Boolean);

export const parseDomainSet = (domains: string[]) => new Set(domains.map(normalizeDomain).filter(Boolean));

export const extractEmailDomain = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return normalizeDomain(email.slice(at + 1));
};

export const findMatchingDomainOrParent = (domain: string, set: Set<string>) => {
  if (set.has(domain)) return domain;
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join(".");
    if (set.has(parent)) return parent;
  }
  return null;
};

export const evaluateEmailDomainAgainstSets = (
  email: string,
  options: {
    allowSet: Set<string>;
    denySet: Set<string>;
    upstreamSet: Set<string>;
  }
): EmailDomainDecision => {
  const normalizedDomain = extractEmailDomain(email);
  if (!normalizedDomain) return { allowed: true };

  const allowMatch = findMatchingDomainOrParent(normalizedDomain, options.allowSet);
  if (allowMatch) {
    return {
      allowed: true,
      source: "local_allow",
      matchedDomain: allowMatch,
      normalizedDomain,
    };
  }

  const denyMatch = findMatchingDomainOrParent(normalizedDomain, options.denySet);
  if (denyMatch) {
    return {
      allowed: false,
      reason: "disposable_domain",
      source: "local_deny",
      matchedDomain: denyMatch,
      normalizedDomain,
    };
  }

  const upstreamMatch = findMatchingDomainOrParent(normalizedDomain, options.upstreamSet);
  if (upstreamMatch) {
    return {
      allowed: false,
      reason: "disposable_domain",
      source: "upstream",
      matchedDomain: upstreamMatch,
      normalizedDomain,
    };
  }

  return { allowed: true, normalizedDomain };
};

