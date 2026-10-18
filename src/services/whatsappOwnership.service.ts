// ─────────────────────────────────────────────
// WHATSAPP PHONE-NUMBER OWNERSHIP (P2: safe transfer foundation)
// ─────────────────────────────────────────────

/*
 * Normalized, authoritative mapping of every supported WhatsApp
 * phone-number ID to the single ChannelConnection that owns it.
 *
 * Replaces JSON-metadata scanning for inbound routing: inbound
 * message/status webhooks resolve the owning seller exclusively
 * through ACTIVE rows here, and fail closed (no arbitrary
 * first-match) when a phone number is unknown or ambiguous.
 *
 * DATABASE INVARIANT (enforced by the partial unique index created
 * in the 20261018120000_add_whatsapp_phone_ownership migration):
 *
 *   at most one ACTIVE row per phoneNumberId.
 *
 * Rows are never deleted: a transfer or disconnect flips
 * isActive to false, preserving full audit history.
 */
model WhatsAppPhoneOwnership {
  id Int @id @default(autoincrement())

  phoneNumberId String

  connectionId Int
  connection   ChannelConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)

  sellerId Int
  seller   Seller @relation(fields: [sellerId], references: [id])

  // WABA the phone number belongs to (from connection metadata).
  wabaId String?

  isActive Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([phoneNumberId])
  @@index([sellerId])
  @@index([connectionId])
}
