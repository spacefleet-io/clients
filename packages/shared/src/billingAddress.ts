/**
 * The buyer's billing name and address (ACCT-INV-02): an optional part of the account settings on the website,
 * stored by the API (`PUT /billing/address`) and frozen into each invoice's snapshot when present.
 * Never asked at checkout. One validation for every side, so a form, the API and the invoice agree on what a valid
 * address is. The address is optional as a whole: every field empty means "no address"; once one field is filled,
 * the required ones must be too.
 */

export type BillingAddress = {
  name: string;
  line1: string;
  line2?: string | null;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2, upper case (`FR`). */
  country: string;
};

/** A validated address: every field trimmed, `line2` null when empty, `country` upper case. */
export type NormalizedBillingAddress = Required<Omit<BillingAddress, "line2">> & { line2: string | null };

export type BillingAddressField = keyof BillingAddress;
export type BillingAddressFieldError = "required" | "too_long" | "invalid";
export type BillingAddressErrors = Partial<Record<BillingAddressField, BillingAddressFieldError>>;

export const BILLING_ADDRESS_MAX_LENGTH: Readonly<Record<BillingAddressField, number>> = {
  name: 120,
  line1: 200,
  line2: 200,
  postalCode: 20,
  city: 100,
  country: 2,
};

/** Every officially assigned ISO 3166-1 alpha-2 code (249). */
export const BILLING_COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const COUNTRY_SET = new Set(BILLING_COUNTRY_CODES);
// Control characters (a pasted newline or tab) would break the invoice layout.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export type BillingAddressValidation =
  | { ok: true; address: NormalizedBillingAddress }
  | { ok: false; errors: BillingAddressErrors };

/** Trims every field and checks it: required fields, maximum lengths, no control characters, a known country code. */
export const validateBillingAddress = (input: unknown): BillingAddressValidation => {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const address: NormalizedBillingAddress = {
    name: text(raw.name),
    line1: text(raw.line1),
    line2: text(raw.line2) || null,
    postalCode: text(raw.postalCode),
    city: text(raw.city),
    country: text(raw.country).toUpperCase(),
  };
  const errors: BillingAddressErrors = {};
  for (const field of ["name", "line1", "line2", "postalCode", "city", "country"] as const) {
    const value = address[field];
    if (value === null || value === "") {
      if (field !== "line2") errors[field] = "required";
      continue;
    }
    if (value.length > BILLING_ADDRESS_MAX_LENGTH[field]) errors[field] = "too_long";
    else if (CONTROL_CHARS.test(value)) errors[field] = "invalid";
  }
  if (!errors.country && !COUNTRY_SET.has(address.country)) errors.country = "invalid";
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, address };
};

const FIELDS: readonly BillingAddressField[] = ["name", "line1", "line2", "postalCode", "city", "country"];
const FIELD_ERRORS: readonly BillingAddressFieldError[] = ["required", "too_long", "invalid"];

/** Every field empty (after trimming): the form means "no billing address", and saving it removes the stored one. */
export const isBlankBillingAddress = (input: unknown): boolean => {
  if (!input || typeof input !== "object") return true;
  return FIELDS.every((field) => {
    const value = field in input ? Reflect.get(input, field) : undefined;
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
};

/**
 * The `fields` of a 400 `invalid_billing_address` answer, keeping only known fields and error codes;
 * null when there is nothing usable (the form then shows its generic save error).
 */
export const readBillingAddressErrors = (fields: unknown): BillingAddressErrors | null => {
  if (!fields || typeof fields !== "object") return null;
  const errors: BillingAddressErrors = {};
  for (const field of FIELDS) {
    const code = field in fields ? Reflect.get(fields, field) : undefined;
    const known = FIELD_ERRORS.find((e) => e === code);
    if (known) errors[field] = known;
  }
  return Object.keys(errors).length > 0 ? errors : null;
};

/** The country's name in `language` (`France`, `Allemagne`), or the code when the runtime has no name for it. */
export const billingCountryName = (code: string, language: string): string => {
  try {
    return new Intl.DisplayNames([language], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The address as printed under the buyer: name, street lines, `<postal code> <city>`, country name. */
export const formatBillingAddressLines = (address: BillingAddress, language: string): string[] => [
  address.name,
  address.line1,
  ...(address.line2 ? [address.line2] : []),
  `${address.postalCode} ${address.city}`,
  billingCountryName(address.country, language),
];
