-- AlterEnum
ALTER TYPE "OrderEventType" ADD VALUE 'STATION_OVERRIDDEN';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "assignedWorkerUserId" TEXT;

-- CreateIndex
CREATE INDEX "orders_assignedWorkerUserId_idx" ON "orders"("assignedWorkerUserId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assignedWorkerUserId_fkey" FOREIGN KEY ("assignedWorkerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
