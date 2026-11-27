import type { ClientUiLanguage } from "@space/shared/i18n";

/** The storage card's own words (STOR-UNIT-02), in the five client languages (UX-I18N-01); sizes come already written in the language. */
export type AccountStorageCardStrings = {
  used: (size: string) => string;
  percentUsed: (percent: number) => string;
  reserved: (size: string) => string;
  byApp: string;
};

export const accountStorageCardStrings: Record<ClientUiLanguage, AccountStorageCardStrings> = {
  en: {
    used: (size) => `${size} used`,
    percentUsed: (percent) => `${percent}% used`,
    reserved: (size) => `${size} reserved by active uploads`,
    byApp: "Storage by app",
  },
  fr: {
    used: (size) => `${size} utilisés`,
    percentUsed: (percent) => `${percent}\u202f% utilisés`,
    reserved: (size) => `${size} réservés par les envois en cours`,
    byApp: "Stockage par application",
  },
  nl: {
    used: (size) => `${size} gebruikt`,
    percentUsed: (percent) => `${percent}% gebruikt`,
    reserved: (size) => `${size} gereserveerd voor lopende uploads`,
    byApp: "Opslag per app",
  },
  de: {
    used: (size) => `${size} belegt`,
    percentUsed: (percent) => `${percent}\u00a0% belegt`,
    reserved: (size) => `${size} für laufende Uploads reserviert`,
    byApp: "Speicher pro App",
  },
  es: {
    used: (size) => `${size} usados`,
    percentUsed: (percent) => `${percent}\u00a0% usado`,
    reserved: (size) => `${size} reservados para subidas en curso`,
    byApp: "Almacenamiento por app",
  },
};
