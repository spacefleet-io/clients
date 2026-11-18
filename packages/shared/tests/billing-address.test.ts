/**
 * The billing address validation every side shares (ACCT-INV-02): the website's settings form, the API's
 * `PUT /billing/address`, and the lines printed under the buyer on invoices and credit notes.
 */
import { describe, expect, it } from "vitest";
import {
  BILLING_ADDRESS_MAX_LENGTH,
  BILLING_COUNTRY_CODES,
  billingCountryName,
  formatBillingAddressLines,
  isBlankBillingAddress,
  readBillingAddressErrors,
  validateBillingAddress,
} from "../src/billingAddress";

const SUITE = "billing-address";

const valid = {
  name: "  Alex Martin ",
  line1: " 12 rue des Lilas",
  line2: "  ",
  postalCode: " 31000 ",
  city: "Toulouse ",
  country: " fr",
};

describe(`[${SUITE}] validateBillingAddress`, () => {
  /** @req ACCT-INV-02[api] */
  it("@req ACCT-INV-02 trims every field, empties line2 to null and upper-cases the country", () => {
    const result = validateBillingAddress(valid);
    console.info(`[${SUITE}] trimmed: ${JSON.stringify(result)}`);
    expect(result).toEqual({
      ok: true,
      address: { name: "Alex Martin", line1: "12 rue des Lilas", line2: null, postalCode: "31000", city: "Toulouse", country: "FR" },
    });
    const withLine2 = validateBillingAddress({ ...valid, line2: " Bât. B " });
    expect(withLine2.ok && withLine2.address.line2).toBe("Bât. B");
  });

  it("names every missing required field; line2 is optional", () => {
    const result = validateBillingAddress({ name: " ", line1: "", postalCode: undefined, city: 3, country: "" });
    console.info(`[${SUITE}] missing: ${JSON.stringify(result)}`);
    expect(result).toEqual({
      ok: false,
      errors: { name: "required", line1: "required", postalCode: "required", city: "required", country: "required" },
    });
    expect(validateBillingAddress(null)).toMatchObject({ ok: false, errors: { name: "required" } });
  });

  it("refuses a field over its maximum length, control characters and an unknown or malformed country", () => {
    const tooLong = validateBillingAddress({
      ...valid,
      name: "x".repeat(BILLING_ADDRESS_MAX_LENGTH.name + 1),
      line2: "y".repeat(BILLING_ADDRESS_MAX_LENGTH.line2 + 1),
      city: "Toulouse\nFrance",
      country: "FRA",
    });
    console.info(`[${SUITE}] too long: ${JSON.stringify(tooLong)}`);
    expect(tooLong).toEqual({ ok: false, errors: { name: "too_long", line2: "too_long", city: "invalid", country: "too_long" } });
    for (const country of ["ZZ", "F1", "xx"]) {
      const result = validateBillingAddress({ ...valid, country });
      console.info(`[${SUITE}] country ${country}: ${JSON.stringify(result)}`);
      expect(result).toEqual({ ok: false, errors: { country: "invalid" } });
    }
    // Exactly at the limit is fine.
    expect(validateBillingAddress({ ...valid, name: "x".repeat(BILLING_ADDRESS_MAX_LENGTH.name) }).ok).toBe(true);
  });

  it("knows the 249 assigned ISO 3166-1 alpha-2 codes, each two upper-case letters, no duplicates", () => {
    console.info(`[${SUITE}] ${BILLING_COUNTRY_CODES.length} codes`);
    expect(BILLING_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(BILLING_COUNTRY_CODES).size).toBe(249);
    for (const code of BILLING_COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
    for (const code of ["FR", "DE", "BE", "CH", "GB", "US", "RE"]) expect(BILLING_COUNTRY_CODES).toContain(code);
  });
});

describe(`[${SUITE}] formatBillingAddressLines`, () => {
  /** @req ACCT-INV-02[api] */
  it("@req ACCT-INV-02 prints name, street lines, postal code and city, and the country name in the document's language", () => {
    const address = { name: "Alex Martin", line1: "12 rue des Lilas", line2: "Bât. B", postalCode: "31000", city: "Toulouse", country: "DE" };
    const en = formatBillingAddressLines(address, "en");
    const fr = formatBillingAddressLines({ ...address, line2: null }, "fr");
    console.info(`[${SUITE}] en=${JSON.stringify(en)} fr=${JSON.stringify(fr)}`);
    expect(en).toEqual(["Alex Martin", "12 rue des Lilas", "Bât. B", "31000 Toulouse", "Germany"]);
    expect(fr).toEqual(["Alex Martin", "12 rue des Lilas", "31000 Toulouse", "Allemagne"]);
    expect(billingCountryName("FR", "fr")).toBe("France");
  });
});

describe(`[${SUITE}] optional address: isBlankBillingAddress, readBillingAddressErrors`, () => {
  /** @req ACCT-INV-02[api] */
  it("@req ACCT-INV-02 treats an all-empty form as no address, and any filled field as an address to validate", () => {
    const cases = [
      [{ name: "", line1: " ", line2: null, postalCode: "", city: "", country: "" }, true],
      [{}, true],
      [null, true],
      [{ name: "", line1: "", line2: "", postalCode: "", city: "Toulouse", country: "" }, false],
      [{ line2: "Bât. B" }, false],
    ] as const;
    for (const [input, blank] of cases) {
      console.info(`[${SUITE}:blank] ${JSON.stringify(input)} -> ${isBlankBillingAddress(input)}`);
      expect(isBlankBillingAddress(input)).toBe(blank);
    }
    // A partial address is refused, not saved as "no address".
    expect(validateBillingAddress({ city: "Toulouse" })).toEqual({
      ok: false,
      errors: { name: "required", line1: "required", postalCode: "required", country: "required" },
    });
  });

  it("keeps only known fields and error codes from a 400 answer", () => {
    const read = readBillingAddressErrors({ name: "required", city: "nope", evil: "required", country: "invalid" });
    console.info(`[${SUITE}:read-errors] ${JSON.stringify(read)}`);
    expect(read).toEqual({ name: "required", country: "invalid" });
    expect(readBillingAddressErrors(undefined)).toBeNull();
    expect(readBillingAddressErrors({ city: 3 })).toBeNull();
  });
});
