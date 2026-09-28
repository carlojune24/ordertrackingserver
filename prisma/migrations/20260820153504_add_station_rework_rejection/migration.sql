-- AlterEnum
ALTER TYPE "OrderEventType" ADD VALUE 'STATION_REJECTED';

-- AlterTable
ALTER TABLE "rework_routes" ALTER COLUMN "qcReviewId" DROP NOT NULL;
