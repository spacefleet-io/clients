/**
 * What a personal API token looks like (DEV-TOK-01). The CLI checks a pasted token against it, and the server never
 * accepts one as a login session.
 * A login session token is a UUID and never starts with this prefix.
 */
export const PERSONAL_TOKEN_PREFIX = "sfpat_";
