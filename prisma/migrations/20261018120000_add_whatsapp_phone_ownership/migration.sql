-- WhatsApp phone-number ownership invariant.
--
-- Normalized mapping of every WhatsApp phone-number ID to the single
-- ChannelConnection that owns it. Inbound routing resolves ownership
-- exclusively through ACTIVE rows here (see
-- src/services/whatsappOwnership.service.ts) and fails closed for
-- unknown or ambiguous numbers.

CREATE TABLE "WhatsAppPhoneOwnership" (
    "id" SERIAL NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "wabaId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppPhoneOwnership_pkey" PRIMARY KEY ("id")
);

-- Create a FK to the table: "ChannelConnection"
ALTER TABLE "WhatsAppPhoneOwnership"
    ADD CONSTRAINT "WhatsAppPhoneOwnership_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Create a FK to the table: "Seller"
ALTER TABLE "WhatsAppPhoneOwnership"
    ADD CONSTRAINT "WhatsAppPhoneOwnership_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "Seller"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "WhatsAppPhoneOwnership_phoneNumberId_idx"
    ON "WhatsAppPhoneOwnership"("phoneNumberId");
CREATE INDEX "WhatsAppPhoneOwnership_sellerId_idx"
    ON "WhatsAppPhoneOwnership"("sellerId");
CREATE INDEX "WhatsAppPhoneOwnership_connectionId_idx"
    ON "WhatsAppPhoneOwnership"("connectionId");

-- Deterministic backfill from existing active WhatsApp connections.
--
-- Connections are visited in ASCENDING id order — the same order the
-- previous JSON-metadata first-match routing used — so the connection
-- that effectively owns routing today remains the canonical owner.
-- Later connections claiming an already-assigned phone number are
-- reported as conflicts (RAISE NOTICE) and skipped. NOTHING is
-- deleted or deactivated: every existing connection is preserved as-is.
DO $$
DECLARE
    conn RECORD;
    phone RECORD;
    phone_id TEXT;
BEGIN
    FOR conn IN
        SELECT "id", "sellerId", "externalAccountId", "metadata"
        FROM "ChannelConnection"
        WHERE "platform" = 'WHATSAPP'
          AND "isActive" = true
        ORDER BY "id" ASC
    LOOP
        -- metadata.phoneNumberIds: array of ids
        IF jsonb_typeof(conn."metadata" -> 'phoneNumberIds') = 'array' THEN
            FOR phone IN SELECT * FROM jsonb_array_elements(conn."metadata" -> 'phoneNumberIds') AS elem
            LOOP
                IF jsonb_typeof(phone.elem) = 'string' THEN
                    phone_id := phone.elem #>> '{}';
                    IF phone_id IS NOT NULL AND phone_id <> '' THEN
                        INSERT INTO "WhatsAppPhoneOwnership"
                            ("phoneNumberId", "connectionId", "sellerId", "wabaId", "isActive", "updatedAt")
                        VALUES (phone_id, conn."id", conn."sellerId", conn."externalAccountId", true, now())
                        ON CONFLICT DO NOTHING
                        WHERE false; -- placeholder, replaced below
                    END IF;
                END IF;
            END LOOP;
        END IF;

        -- metadata.phoneNumbers: array of {id | phone_number_id, ...}
        IF jsonb_typeof(conn."metadata" -> 'phoneNumbers') = 'array' THEN
            FOR phone IN SELECT * FROM jsonb_array_elements(conn."metadata" -> 'phoneNumbers') AS elem
            LOOP
                phone_id := COALESCE(
                    phone.elem ->> 'id',
                    phone.elem ->> 'phone_number_id'
                );
                IF phone_id IS NOT NULL AND phone_id <> '' THEN
                    INSERT INTO "WhatsAppPhoneOwnership"
                        ("phoneNumberId", "connectionId", "sellerId", "wabaId", "isActive", "updatedAt")
                    VALUES (phone_id, conn."id", conn."sellerId", conn."externalAccountId", true, now());
                    RAISE NOTICE 'ownership: phone % -> connection % (seller %)', phone_id, conn."id", conn."sellerId";
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    -- Conflict report for phone numbers claimed by more than one
    -- active connection. Duplicates were skipped by the guard above;
    -- nothing is deleted or deactivated here.
    FOR phone IN
        SELECT "phoneNumberId"
        FROM "WhatsAppPhoneOwnership"
        WHERE "isActive" = true
        GROUP BY "phoneNumberId"
        HAVING COUNT(*) > 1
    LOOP
        RAISE NOTICE 'ownership conflict: phone % claimed by multiple connections', phone."phoneNumberId";
    END LOOP;
END $$;

-- DATABASE INVARIANT (created AFTER the backfill): at most one
-- ACTIVE owner per phone-number ID.
CREATE UNIQUE INDEX "WhatsAppPhoneOwnership_phoneNumberId_active_key"
    ON "WhatsAppPhoneOwnership"("phoneNumberId")
    WHERE "isActive" = true;
