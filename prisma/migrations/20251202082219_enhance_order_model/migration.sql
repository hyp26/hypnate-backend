/*
  Enhancing Order model to match frontend's required rich structure.

  New fields:
    customerName, customerPhone, customerEmail, shippingAddress,
    subtotal, tax, paymentStatus, paymentMethod,
    trackingNumber, timeline (JSON)

  Modify:
    customer → customerName
    totalAmount remains but becomes sum(subtotal + tax)

  Existing data will be preserved (customer → customerName).
*/

----------------------------------------------------------
-- 1. Add nullable new columns first (safe for existing data)
----------------------------------------------------------

ALTER TABLE "Order"
  ADD COLUMN "customerName"     TEXT,
  ADD COLUMN "customerPhone"    TEXT,
  ADD COLUMN "customerEmail"    TEXT,
  ADD COLUMN "shippingAddress"  TEXT,
  ADD COLUMN "subtotal"         DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN "tax"              DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN "paymentStatus"    TEXT DEFAULT 'UNPAID',
  ADD COLUMN "paymentMethod"    TEXT,
  ADD COLUMN "trackingNumber"   TEXT,
  ADD COLUMN "timeline"         JSONB;

----------------------------------------------------------
-- 2. Backfill customerName from old "customer" column
----------------------------------------------------------

UPDATE "Order"
SET "customerName" = "customer"
WHERE "customerName" IS NULL;

----------------------------------------------------------
-- 3. Drop old unused "customer" column
----------------------------------------------------------

ALTER TABLE "Order"
  DROP COLUMN "customer";

----------------------------------------------------------
-- 4. Make customerName required (NOT NULL)
----------------------------------------------------------

ALTER TABLE "Order"
  ALTER COLUMN "customerName" SET NOT NULL;

----------------------------------------------------------
-- 5. Optional: add priceAtPurchase to ProductOrder
----------------------------------------------------------

ALTER TABLE "ProductOrder"
  ADD COLUMN "priceAtPurchase" DOUBLE PRECISION;

-- Backfill price from Product table for historical accuracy
UPDATE "ProductOrder" po
SET "priceAtPurchase" = p.price
FROM "Product" p
WHERE p.id = po."productId";

----------------------------------------------------------
-- 6. Ensure timeline is initialized as an empty JSON array
----------------------------------------------------------

UPDATE "Order"
SET "timeline" = '[]'
WHERE "timeline" IS NULL;

----------------------------------------------------------
-- 7. Migration complete
----------------------------------------------------------
