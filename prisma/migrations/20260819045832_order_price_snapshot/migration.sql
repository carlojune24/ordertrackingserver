/*
  Warnings:

  - Added the required column `regularPriceAtOrder` to the `orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `unitPrice` to the `orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "regularPriceAtOrder" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "unitPrice" DOUBLE PRECISION NOT NULL;
