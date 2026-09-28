-- AlterTable
ALTER TABLE "rework_routes" ADD COLUMN     "fromStationId" TEXT;

-- CreateIndex
CREATE INDEX "rework_routes_fromStationId_idx" ON "rework_routes"("fromStationId");

-- AddForeignKey
ALTER TABLE "rework_routes" ADD CONSTRAINT "rework_routes_fromStationId_fkey" FOREIGN KEY ("fromStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
