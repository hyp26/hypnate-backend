import crypto from "crypto";

/**
 * Hash a security token before storing or looking it up in the database.
 *
 * Tokens are generated with cryptographically secure randomness, so
 * SHA-256 is appropriate here and allows direct indexed database lookups.
 */
export const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");