-- CreateEnum
CREATE TYPE "ReturnOutcome" AS ENUM ('SEND_TO_QC', 'FOR_REPLACEMENT');

-- CreateEnum
CREATE TYPE "ReplacementStatus" AS ENUM ('NONE', 'FLAGGED', 'ISSUED');

-- AlterEnum
ALTER TYPE "OrderEventType" ADD VALUE 'RETURN_DECISION';
ALTER TYPE "OrderEventType" ADD VALUE 'REPLACEMENT_ISSUED';

-- AlterTable
ALTER TABLE "stations" ADD COLUMN     "isReturnStation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "replacementFlaggedAt" TIMESTAMP(3),

ADD COLUMN     "replacementIssuedAt" TIMESTAMP(3),
ADD COLUMN     "replacementStatus" "ReplacementStatus" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "return_reviews" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stationVisitId" TEXT NOT NULL,
    "outcome" "ReturnOutcome" NOT NULL,
    "decidedByUserId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_reviews_orderId_idx" ON "return_reviews"("orderId");

-- AddForeignKey
ALTER TABLE "return_reviews" ADD CONSTRAINT "return_reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
