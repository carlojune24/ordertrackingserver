/*
  Warnings:

  - You are about to drop the column `colorLiningId` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `discountAmount` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `discountReason` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `productId` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `regularPriceAtOrder` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `unitPrice` on the `orders` table. All the data in the column will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderEventType" ADD VALUE 'ITEM_ADDED';
ALTER TYPE "OrderEventType" ADD VALUE 'ITEM_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE 'ITEM_REMOVED';

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_colorLiningId_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_productId_fkey";

-- DropIndex
DROP INDEX "orders_productId_idx";

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "colorLiningId",
DROP COLUMN "discountAmount",
DROP COLUMN "discountReason",
DROP COLUMN "productId",
DROP COLUMN "regularPriceAtOrder",
DROP COLUMN "unitPrice";

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "colorLiningId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "regularPriceAtOrder" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rework_route_items" (
    "id" TEXT NOT NULL,
    "reworkRouteId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rework_route_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "rework_route_items_orderItemId_idx" ON "rework_route_items"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "rework_route_items_reworkRouteId_orderItemId_key" ON "rework_route_items"("reworkRouteId", "orderItemId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_colorLiningId_fkey" FOREIGN KEY ("colorLiningId") REFERENCES "product_color_linings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_route_items" ADD CONSTRAINT "rework_route_items_reworkRouteId_fkey" FOREIGN KEY ("reworkRouteId") REFERENCES "rework_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_route_items" ADD CONSTRAINT "rework_route_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
