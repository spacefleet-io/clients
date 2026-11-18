/**
 * The React side of the data credits (META-SRC-09, UX-SET-02), apart from `credits.ts` so a process without React (the
 * Parrot desktop's main process asks the service for its window) never bundles it.
 */
import { useEffect, useEffectEvent, useState } from "react";
import { creditsStoreKey, parseSourceCredits, type CreditsProduct, type CreditsSource, type CreditsStore, type SourceCredits } from "./credits";

const readStored = async (store: CreditsStore, key: string): Promise<SourceCredits | null> => {
  try {
    const raw = await store.getItem(key);
    return raw ? parseSourceCredits(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
};

/**
 * The credits to show for `product` in `language`: the kept answer first, then the service's once it arrives (and
 * kept for next time). Null until either exists: the panel then shows its neutral offline line. Asked once per
 * product and language: a `source` rebuilt on each render does not ask again.
 */
export function useSourceCredits(product: CreditsProduct, language: string, source: CreditsSource): SourceCredits | null {
  const [credits, setCredits] = useState<SourceCredits | null>(null);
  const currentSource = useEffectEvent(() => source);

  useEffect(() => {
    let live = true;
    const { load, store } = currentSource();
    const key = creditsStoreKey(product, language);
    setCredits(null);
    void (async () => {
      const kept = store ? await readStored(store, key) : null;
      if (live && kept) setCredits(kept);
      if (!load) return;
      try {
        const fresh = await load(product, language);
        if (!live) return;
        setCredits(fresh);
        await store?.setItem(key, JSON.stringify(fresh));
      } catch (error) {
        // Offline or refused: the kept answer (or the neutral line) stays.
        console.info(`[credits] ${product} ${language}: not refreshed (${error instanceof Error ? error.message : "unknown error"})`);
      }
    })();
    return () => {
      live = false;
    };
  }, [product, language]);

  return credits;
}
