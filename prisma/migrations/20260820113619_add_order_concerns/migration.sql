-- CreateEnum
CREATE TYPE "OrderConcernType" AS ENUM ('CONCERN', 'CLARIFICATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderEventType" ADD VALUE 'CONCERN_RAISED';
ALTER TYPE "OrderEventType" ADD VALUE 'CONCERN_RESOLVED';

-- CreateTable
CREATE TABLE "order_concerns" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "stationVisitId" TEXT,
    "type" "OrderConcernType" NOT NULL,
    "message" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_concerns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_concerns_orderId_createdAt_idx" ON "order_concerns"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_concerns_stationId_idx" ON "order_concerns"("stationId");

-- AddForeignKey
ALTER TABLE "order_concerns" ADD CONSTRAINT "order_concerns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_concerns" ADD CONSTRAINT "order_concerns_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
