-- AlterTable
ALTER TABLE "stations" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "assignedStationId" TEXT;

-- CreateIndex
CREATE INDEX "users_assignedStationId_idx" ON "users"("assignedStationId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_assignedStationId_fkey" FOREIGN KEY ("assignedStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
