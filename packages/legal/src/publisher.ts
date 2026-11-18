/**
 * The publisher's postal address, the one source for every document that prints it: the legal notice (WEB-LEGAL-02),
 * the privacy policy's controller identity (WEB-LEGAL-03), the terms' withdrawal route and model withdrawal form
 * (WEB-LEGAL-05) and the seller block of invoices and credit notes (ACCT-INV-02).
 *
 * The EI's domiciliation address at idomyou (Chris 2026-11-12: "we should also switch the address on indy, and add the
 * idomyou address on the website to meet the legal requirements"). The publisher's private address is never published. One line
 * ending with the country; `null` would leave the address out of every one of those documents.
 */
export const PUBLISHER_POSTAL_ADDRESS: string | null = "8 bis rue Abel, 75012 Paris, France";

const POSTAL_SEGMENT = /\[\[postal:(.*?)\]\]/g;
const ADDRESS_PLACEHOLDER = /\{\{publisherPostalAddress\}\}/g;

/**
 * Fills a legal text's postal parts: a `[[postal:…]]` segment is kept, with `{{publisherPostalAddress}}` replaced by the
 * address, when there is one, and dropped when there is none.
 */
export const withPublisherPostalAddress = (text: string, address: string | null = PUBLISHER_POSTAL_ADDRESS): string =>
  text.replace(POSTAL_SEGMENT, (_, segment: string) =>
    address === null ? "" : segment.replace(ADDRESS_PLACEHOLDER, () => address),
  );
