-- CreateTable
CREATE TABLE "order_item_station_progress" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "stationVisitId" TEXT NOT NULL,
    "isFinished" BOOLEAN NOT NULL DEFAULT false,
    "finishedAt" TIMESTAMP(3),
    "finishedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_station_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_station_progress_stationVisitId_idx" ON "order_item_station_progress"("stationVisitId");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_station_progress_orderItemId_stationVisitId_key" ON "order_item_station_progress"("orderItemId", "stationVisitId");

-- AddForeignKey
ALTER TABLE "order_item_station_progress" ADD CONSTRAINT "order_item_station_progress_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_station_progress" ADD CONSTRAINT "order_item_station_progress_stationVisitId_fkey" FOREIGN KEY ("stationVisitId") REFERENCES "station_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
