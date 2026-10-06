import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decrypt, encrypt } from "./crypto.service";

describe("AES-256-GCM round-trip", () => {
  it("decrypts a value produced by encrypt()", () => {
    const plaintext = "diagnostic plaintext";

    const encrypted = encrypt(plaintext);

    const decrypted = decrypt(encrypted);

    assert.equal(decrypted, plaintext);
  });

  it("serializes GCM values with the gcm:v1: prefix", () => {
    const encrypted = encrypt("diagnostic plaintext");

    assert.ok(encrypted.startsWith("gcm:v1:"));
  });
});
