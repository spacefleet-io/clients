/**
 * Where a re-sealed copy is stored (STOR-RESEAL-03): a new name next to the old object, never over it. The copy keeps
 * the old key's folder (so the same placement `media/<id>/` or silo `shards/<id>/`, which the API checks) and takes a
 * fresh lowercase UUID as its last part, so a list of `media/<placement>/<uuid>` keys still packs as key mode 1
 * (LIB-FMT-11).
 */
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";

export const resealCopyKey = (oldKey: string, uuid: string = crypto.randomUUID()): string => {
  const slash = oldKey.lastIndexOf("/");
  return slash < 0 ? uuid : `${oldKey.slice(0, slash)}/${uuid}`;
};

/** The media placement a key is stored under, if any: its copy is uploaded through that placement's silo. */
export const placementOfKey = (key: string): string | null => parseMediaPlacementIdFromObjectKey(key);
