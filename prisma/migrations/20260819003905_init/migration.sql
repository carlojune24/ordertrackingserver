-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PRODUCTION_STAFF', 'SUPERVISOR', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('INTAKE', 'CUTTING', 'SEWING', 'EMBROIDERY', 'QC', 'PACKAGING', 'COURIER_PICKUP', 'DELIVERED', 'RETURNED');

-- CreateEnum
CREATE TYPE "Station" AS ENUM ('CUTTING', 'SEWING', 'EMBROIDERY', 'QC', 'PACKAGING', 'COURIER_PICKUP');

-- CreateEnum
CREATE TYPE "QcOutcome" AS ENUM ('APPROVED', 'REWORK');

-- CreateEnum
CREATE TYPE "DeliveryOutcomeType" AS ENUM ('DELIVERED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECT', 'DISSATISFACTION', 'MISSING_OR_LACKING');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('INTAKE_CREATED', 'STATION_RECEIVED', 'STATION_OUTGOING', 'QC_DECISION', 'REWORK_ROUTED', 'DELIVERY_CONFIRMED', 'RETURNED_TO_SENDER', 'QR_REGENERATED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerContact" TEXT,
    "carModel" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proposedDurationDays" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER,
    "currentStage" "Stage" NOT NULL DEFAULT 'INTAKE',
    "currentStation" "Station",
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_visits" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "station" "Station" NOT NULL,
    "sequenceNo" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "outgoingAt" TIMESTAMP(3),
    "outgoingByUserId" TEXT,
    "isReworkVisit" BOOLEAN NOT NULL DEFAULT false,
    "reworkRouteId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "station_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_reviews" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stationVisitId" TEXT NOT NULL,
    "outcome" "QcOutcome" NOT NULL,
    "reviewedByUserId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rework_routes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "qcReviewId" TEXT NOT NULL,
    "targetStation" "Station" NOT NULL,
    "reason" TEXT,
    "resultingStationVisitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rework_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_outcomes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "outcome" "DeliveryOutcomeType" NOT NULL,
    "customerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "returnReason" "ReturnReason",
    "responsibleStation" "Station",
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "station" "Station",
    "actorUserId" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_qrToken_key" ON "orders"("qrToken");

-- CreateIndex
CREATE INDEX "orders_currentStage_idx" ON "orders"("currentStage");

-- CreateIndex
CREATE INDEX "orders_priority_idx" ON "orders"("priority");

-- CreateIndex
CREATE INDEX "orders_deadline_idx" ON "orders"("deadline");

-- CreateIndex
CREATE INDEX "station_visits_orderId_idx" ON "station_visits"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "station_visits_orderId_station_sequenceNo_key" ON "station_visits"("orderId", "station", "sequenceNo");

-- CreateIndex
CREATE INDEX "qc_reviews_orderId_idx" ON "qc_reviews"("orderId");

-- CreateIndex
CREATE INDEX "rework_routes_orderId_idx" ON "rework_routes"("orderId");

-- CreateIndex
CREATE INDEX "delivery_outcomes_orderId_idx" ON "delivery_outcomes"("orderId");

-- CreateIndex
CREATE INDEX "order_events_orderId_createdAt_idx" ON "order_events"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_visits" ADD CONSTRAINT "station_visits_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_reviews" ADD CONSTRAINT "qc_reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_routes" ADD CONSTRAINT "rework_routes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_outcomes" ADD CONSTRAINT "delivery_outcomes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
