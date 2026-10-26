-- Super Admin free-access grants (SellerFreeAccessGrant).
--
-- Additive, forward-only migration. Never edit previously
-- deployed migrations.
--
-- A grant provides the selected plan's capabilities without
-- payment, entirely separate from the paid-subscription fields
-- on "Seller" (activePlan / planStatus / planActivatedAt /
-- planCurrentPeriodEnd / razorpaySubscriptionId) and from the
-- trial fields.
--
-- DATABASE INVARIANT (authoritative here, NOT expressible in
-- prisma/schema.prisma): at most one ACTIVE (revokedAt IS NULL)
-- grant row per seller, enforced by the partial unique index
-- "SellerFreeAccessGrant_sellerId_active_key".
--
-- WARNING: `prisma db push` on this schema would DROP that
-- partial index because Prisma cannot model it. Always use
-- `prisma migrate deploy` on deployed databases.

-- Defensive duplicate check (harmless for a brand-new table,
-- kept so the invariant is verified at migration time too).
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'SellerFreeAccessGrant'
  ) THEN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
      SELECT "sellerId"
      FROM "SellerFreeAccessGrant"
      WHERE "revokedAt" IS NULL
      GROUP BY "sellerId"
      HAVING COUNT(*) > 1
    ) duplicates;

    IF duplicate_count > 0 THEN
      RAISE EXCEPTION
        'Duplicate active SellerFreeAccessGrant rows detected (% seller(s)). Refusing to continue: resolve duplicates manually before migrating.',
        duplicate_count;
    END IF;
  END IF;
END
$$;

-- Create the table.
CREATE TABLE "SellerFreeAccessGrant" (
    "id" SERIAL PRIMARY KEY,
    "sellerId" INTEGER NOT NULL REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "plan" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "grantedByAdminId" INTEGER NOT NULL REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "revokedAt" TIMESTAMP(3),
    "revokedByAdminId" INTEGER REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Lookups: the active grant for a seller.
CREATE INDEX "SellerFreeAccessGrant_sellerId_idx" ON "SellerFreeAccessGrant"("sellerId");
CREATE INDEX "SellerFreeAccessGrant_grantedByAdminId_idx" ON "SellerFreeAccessGrant"("grantedByAdminId");

-- THE INVARIANT: one active grant per seller. Prisma cannot
-- express partial unique indexes, so this SQL is authoritative.
CREATE UNIQUE INDEX "SellerFreeAccessGrant_sellerId_active_key"
  ON "SellerFreeAccessGrant"("sellerId")
  WHERE "revokedAt" IS NULL;

-- Fail loudly if the index was not created with the exact
-- expected definition (defense in depth).
DO $$
DECLARE
  index_definition TEXT;
BEGIN
  SELECT pg_get_indexdef(
    c.oid
  ) INTO index_definition
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'SellerFreeAccessGrant_sellerId_active_key'
    AND n.nspname = 'public';

  IF index_definition IS NULL THEN
    RAISE EXCEPTION 'Expected unique index SellerFreeAccessGrant_sellerId_active_key was not created';
  END IF;

  IF index_definition NOT LIKE '%UNIQUE INDEX%' THEN
    RAISE EXCEPTION 'Index SellerFreeAccessGrant_sellerId_active_key is not UNIQUE: %', index_definition;
  END IF;

  IF index_definition NOT LIKE '%("sellerId")%' THEN
    RAISE EXCEPTION 'Index SellerFreeAccessGrant_sellerId_active_key does not index ("sellerId"): %', index_definition;
  END IF;

  IF index_definition NOT LIKE '%WHERE ("revokedAt" IS NULL)%' THEN
    RAISE EXCEPTION 'Index SellerFreeAccessGrant_sellerId_active_key lacks the active-row predicate: %', index_definition;
  END IF;
END
$$;
