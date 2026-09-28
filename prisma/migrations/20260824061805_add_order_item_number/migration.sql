/*
  Warnings:

  - Added the required column `itemNo` to the `order_items` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "itemNo" INTEGER;

-- Backfill existing rows: position within their order, ordered by createdAt (the same
-- order the app already lists items in), so pre-existing data gets sensible numbering.
UPDATE "order_items" oi
SET "itemNo" = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "orderId" ORDER BY "createdAt" ASC) AS rn
  FROM "order_items"
) sub
WHERE oi.id = sub.id;

ALTER TABLE "order_items" ALTER COLUMN "itemNo" SET NOT NULL;
