import { SignOptions } from "jsonwebtoken";

/**
 * Reads and normalizes JWT + bcrypt configuration values.
 */

export const JWT_SECRET = process.env.JWT_SECRET || "secretkey";
export const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY ?? "7d";
export const SALT_ROUNDS = Number(process.env.SALT_ROUNDS) || 10;

/**
 * Converts strings like "7d", "24h", "30m", "15s" or plain numbers
 * into seconds. Returns undefined if the format is invalid.
 */
export function parseExpiry(exp?: string): number | undefined {
  if (!exp) return undefined;
  const trimmed = exp.trim();

  // plain numeric seconds
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const match = trimmed.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 60 * 60 * 24;
    default:
      return undefined;
  }
}

/**
 * Build jwtOptions for jsonwebtoken.sign()
 */
export const expiresInSeconds = parseExpiry(TOKEN_EXPIRY);
export const jwtOptions: SignOptions = expiresInSeconds
  ? { expiresIn: expiresInSeconds }
  : {};
