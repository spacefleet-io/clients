import { useEffect, useState } from "react";
import { getKeyRotationReadiness } from "./api";
import type { KeyRotationReadiness } from "./keyChange";

/**
 * ACCT-KEYCHG-04: the server's answer to "would a key rotation be accepted now" (`GET /library/recovery/rotate`), for
 * `keyChangeOffered` / `keyRecoveryOffered`. The same hook for React DOM and React Native. Null while it loads, when
 * signed out, and when the call fails: the entry stays hidden rather than lead to a refusal.
 */
export const useKeyRotationReadiness = (token: string | null | undefined): KeyRotationReadiness | null => {
  const [readiness, setReadiness] = useState<KeyRotationReadiness | null>(null);

  useEffect(() => {
    setReadiness(null);
    if (!token) return undefined;
    let live = true;
    getKeyRotationReadiness(token).then(
      (answer) => {
        if (live) setReadiness({ needsMediaReseal: answer.needsMediaReseal });
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [token]);

  return readiness;
};
