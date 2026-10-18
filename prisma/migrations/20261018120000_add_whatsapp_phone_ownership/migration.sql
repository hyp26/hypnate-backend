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
    FOREIGN KEY ("connectionId")
    REFERENCES "ChannelConnection"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

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
    elem RECORD;
    phone_id TEXT;
    owner RECORD;
BEGIN
    FOR conn IN
        SELECT "id", "sellerId", "externalAccountId", "metadata"
        FROM "ChannelConnection"
        WHERE "platform" = 'WHATSAPP'
          AND "isActive" = true
        ORDER BY "id" ASC
    LOOP
        -- metadata.phoneNumberIds: array of id strings
        IF jsonb_typeof(conn."metadata" -> 'phoneNumberIds') = 'array' THEN
            FOR elem IN
                SELECT * FROM jsonb_array_elements(conn."metadata" -> 'phoneNumberIds') AS e(v)
            LOOP
                phone_id := NULL;
                IF jsonb_typeof(elem.v) = 'string' THEN
                    phone_id := btrim(elem.v #>> '{}');
                END IF;

                IF phone_id IS NOT NULL AND phone_id <> '' THEN
                    SELECT * INTO owner
                    FROM "WhatsAppPhoneOwnership"
                    WHERE "phoneNumberId" = phone_id AND "isActive" = true
                    LIMIT 1;
                    IF NOT FOUND THEN
                                            INSERT INTO "WhatsAppPhoneOwnership"
                            ("phoneNumberId", "connectionId", "sellerId", "wabaId", "isActive", "updatedAt")
                        VALUES (phone_id, conn."id", conn."sellerId", conn."externalAccountId", true, now());
                        RAISE NOTICE 'ownership: phone % -> connection % (seller %)', phone_id, conn."id", conn."sellerId";
                    ELSIF owner."connectionId" = conn."id" THEN
                        RAISE NOTICE 'ownership: phone % already assigned to connection % (duplicate metadata entry; skipped)', phone_id, conn."id";
                    ELSE
                        RAISE NOTICE 'ownership conflict: phone % already owned by connection %; skipping connection %', phone_id, owner."connectionId", conn."id";
                    END IF;
                END IF;
            END LOOP;
        END IF;

        -- metadata.phoneNumbers: array of {id | phone_number_id, ...}
        IF jsonb_typeof(conn."metadata" -> 'phoneNumbers') = 'array' THEN
            FOR elem IN
                SELECT * FROM jsonb_array_elements(conn."metadata" -> 'phoneNumbers') AS e(v)
            LOOP
                phone_id := COALESCE(
                    NULLIF(btrim(elem.v ->> 'id'), ''),
                    NULLIF(btrim(elem.v ->> 'phone_number_id'), '')
                );

                IF phone_id IS NOT NULL THEN
                    SELECT * INTO owner
                    FROM "WhatsAppPhoneOwnership"
                    WHERE "phoneNumberId" = phone_id AND "isActive" = true
                    LIMIT 1;
                    IF NOT FOUND THEN
                        INSERT INTO "WhatsAppPhoneOwnership"
                            ("phoneNumberId", "connectionId", "sellerId", "wabaId", "isActive", "updatedAt")
                        VALUES (phone_id, conn."id", conn."sellerId", conn."externalAccountId", true, now());
                        RAISE NOTICE 'ownership: phone % -> connection % (seller %)', phone_id, conn."id", conn."sellerId";
                    ELSIF owner."connectionId" = conn."id" THEN
                        RAISE NOTICE 'ownership: phone % already assigned to connection % (duplicate metadata entry; skipped)', phone_id, conn."id";
                    ELSE
                        RAISE NOTICE 'ownership conflict: phone % already owned by connection %; skipping connection %', phone_id, owner."connectionId", conn."id";
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    -- Final conflict report: any phone number claimed by more than one
    -- ACTIVE row (should be impossible after the guards above, but
    -- reported defensively). Nothing is deleted or deactivated here.
    FOR owner IN
        SELECT "phoneNumberId"
        FROM "WhatsAppPhoneOwnership"
        WHERE "isActive" = true
        GROUP BY "phoneNumberId"
        HAVING COUNT(*) > 1
    LOOP
        RAISE NOTICE 'ownership conflict: phone % claimed by multiple active rows', owner."phoneNumberId";
    END LOOP;
END $$;

-- DATABASE INVARIANT (created AFTER the backfill): at most one
-- ACTIVE owner per phone-number ID.
CREATE UNIQUE INDEX "WhatsAppPhoneOwnership_phoneNumberId_active_key"
    ON "WhatsAppPhoneOwnership"("phoneNumberId")
    WHERE "isActive" = true;
