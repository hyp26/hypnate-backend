
-- Enforce that every BuildJob belongs to the same seller
-- as its referenced Store.

-- Required as the referenced composite key for the FK.
CREATE UNIQUE INDEX "Store_id_sellerId_key"
ON "Store" ("id", "sellerId");

-- Fail closed if historical data violates the invariant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "BuildJob" bj
        JOIN "Store" s ON s."id" = bj."storeId"
        WHERE bj."sellerId" <> s."sellerId"
    ) THEN
        RAISE EXCEPTION
            'Cannot enforce HypnateX ownership: BuildJob sellerId does not match Store sellerId';
    END IF;
END $$;

-- Add the composite ownership constraint.
ALTER TABLE "BuildJob"
ADD CONSTRAINT "BuildJob_storeId_sellerId_fkey"
FOREIGN KEY ("storeId", "sellerId")
REFERENCES "Store" ("id", "sellerId")
ON DELETE RESTRICT
ON UPDATE RESTRICT;

-- Remove the previous single-column foreign key.
ALTER TABLE "BuildJob"
DROP CONSTRAINT "BuildJob_storeId_fkey";
