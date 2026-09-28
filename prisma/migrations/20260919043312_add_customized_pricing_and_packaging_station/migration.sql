/*
  Warnings:

  - Added the required column `customizedPrice` to the `product_price_history` table without a default value. This is not possible if the table is not empty.
  - Added the required column `customizedPrice` to the `products` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "isCustomized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT;

-- AlterTable: add nullable first, backfill from regularPrice (no prior "customized" price
-- existed, so the regular price is the only sane starting point for existing rows), then
-- enforce NOT NULL — safe against the non-empty tables this ran against.
ALTER TABLE "product_price_history" ADD COLUMN     "customizedPrice" DOUBLE PRECISION;
UPDATE "product_price_history" SET "customizedPrice" = "regularPrice" WHERE "customizedPrice" IS NULL;
ALTER TABLE "product_price_history" ALTER COLUMN "customizedPrice" SET NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "customizedPrice" DOUBLE PRECISION;
UPDATE "products" SET "customizedPrice" = "regularPrice" WHERE "customizedPrice" IS NULL;
ALTER TABLE "products" ALTER COLUMN "customizedPrice" SET NOT NULL;
