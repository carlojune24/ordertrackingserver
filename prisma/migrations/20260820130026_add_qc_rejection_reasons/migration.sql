-- AlterEnum
ALTER TYPE "ActivityLogEntityType" ADD VALUE 'QC_REJECTION_REASON';

-- AlterTable
ALTER TABLE "rework_routes" ADD COLUMN     "rejectionReasonId" TEXT;

-- CreateTable
CREATE TABLE "qc_rejection_reasons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qc_rejection_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qc_rejection_reasons_name_key" ON "qc_rejection_reasons"("name");

-- CreateIndex
CREATE UNIQUE INDEX "qc_rejection_reasons_slug_key" ON "qc_rejection_reasons"("slug");

-- CreateIndex
CREATE INDEX "rework_routes_rejectionReasonId_idx" ON "rework_routes"("rejectionReasonId");

-- AddForeignKey
ALTER TABLE "rework_routes" ADD CONSTRAINT "rework_routes_rejectionReasonId_fkey" FOREIGN KEY ("rejectionReasonId") REFERENCES "qc_rejection_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
