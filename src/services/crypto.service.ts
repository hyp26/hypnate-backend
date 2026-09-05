import crypto from "crypto";
import { ENV } from "../config/env";

const key = crypto
  .createHash("sha256")
  .update(ENV.ENCRYPTION_KEY, "utf8")
  .digest();

const GCM_PREFIX = "gcm:v1";
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/**
 * AES-256-GCM authenticated encryption.
 *
 * Format:
 *
 * gcm:v1:<iv>:<authTag>:<ciphertext>
 *
 * The authentication tag protects the ciphertext against
 * undetected modification.
 */
export const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(text, "utf8")),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    GCM_PREFIX,
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
};

/**
 * Decrypts current AES-256-GCM values.
 *
 * Legacy AES-256-CBC values are supported temporarily so existing
 * credentials remain readable during the migration window.
 *
 * The migration script must be run before removing legacy CBC support.
 */
export const decrypt = (encryptedText: string): string => {
  if (encryptedText.startsWith(`${GCM_PREFIX}:`)) {
    return decryptGcm(encryptedText);
  }

  return decryptLegacyCbc(encryptedText);
};

const decryptGcm = (encryptedText: string): string => {
  const parts = encryptedText.split(":");

  if (parts.length !== 4 || parts[0] !== GCM_PREFIX) {
    throw new Error("Invalid encrypted value format");
  }

  const [, ivHex, authTagHex, ciphertextHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error("Invalid encryption IV");
  }

  if (authTag.length !== GCM_TAG_LENGTH) {
    throw new Error("Invalid encryption authentication tag");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

/**
 * Legacy AES-256-CBC decryption.
 *
 * This exists only to support values encrypted before HYP-002-19.
 * Existing values should be re-encrypted with encrypt() and therefore
 * converted to AES-256-GCM.
 */
const decryptLegacyCbc = (encryptedText: string): string => {
  const parts = encryptedText.split(":");

  if (parts.length !== 2) {
    throw new Error("Invalid legacy encrypted value format");
  }

  const [ivHex, ciphertextHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  if (iv.length !== 16) {
    throw new Error("Invalid legacy encryption IV");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    key,
    iv
  );

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};