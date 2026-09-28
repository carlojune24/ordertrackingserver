-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "itemCounter" INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing orders' counter must start at (at least) the highest itemNo already
-- assigned to one of their items, or the very next add would collide with it.
UPDATE "orders" o
SET "itemCounter" = sub.max_item_no
FROM (
  SELECT "orderId", MAX("itemNo") AS max_item_no
  FROM "order_items"
  GROUP BY "orderId"
) sub
WHERE o.id = sub."orderId";
