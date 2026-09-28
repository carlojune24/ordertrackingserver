
-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('IN_PROGRESS', 'DELIVERED');

-- DropIndex
DROP INDEX "orders_currentStage_idx";

-- DropIndex
DROP INDEX "station_visits_orderId_station_sequenceNo_key";

-- AlterTable
ALTER TABLE "delivery_outcomes" DROP COLUMN "responsibleStation",
ADD COLUMN     "responsibleStationId" TEXT;

-- AlterTable
ALTER TABLE "order_events" DROP COLUMN "station",
ADD COLUMN     "stationId" TEXT;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "currentStage",
DROP COLUMN "currentStation",
ADD COLUMN     "currentStationId" TEXT,
ADD COLUMN     "isCheckedIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "OrderStatus" NOT NULL DEFAULT 'IN_PROGRESS';

-- AlterTable
ALTER TABLE "rework_routes" DROP COLUMN "targetStation",
ADD COLUMN     "targetStationId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "station_visits" DROP COLUMN "station",
ADD COLUMN     "stationId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "Stage";

-- DropEnum
DROP TYPE "Station";

-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT,
    "colorHex" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isQcCheckpoint" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stations_name_key" ON "stations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stations_slug_key" ON "stations"("slug");

-- CreateIndex
CREATE INDEX "delivery_outcomes_responsibleStationId_idx" ON "delivery_outcomes"("responsibleStationId");

-- CreateIndex
CREATE INDEX "order_events_stationId_idx" ON "order_events"("stationId");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_currentStationId_idx" ON "orders"("currentStationId");

-- CreateIndex
CREATE INDEX "rework_routes_targetStationId_idx" ON "rework_routes"("targetStationId");

-- CreateIndex
CREATE INDEX "station_visits_stationId_idx" ON "station_visits"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "station_visits_orderId_stationId_sequenceNo_key" ON "station_visits"("orderId", "stationId", "sequenceNo");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_currentStationId_fkey" FOREIGN KEY ("currentStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_visits" ADD CONSTRAINT "station_visits_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_routes" ADD CONSTRAINT "rework_routes_targetStationId_fkey" FOREIGN KEY ("targetStationId") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_outcomes" ADD CONSTRAINT "delivery_outcomes_responsibleStationId_fkey" FOREIGN KEY ("responsibleStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

