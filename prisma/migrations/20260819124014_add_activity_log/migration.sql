-- CreateEnum
CREATE TYPE "ActivityLogAction" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'REFRESH_TOKEN_REUSE_DETECTED', 'CREATED', 'UPDATED');

-- CreateEnum
CREATE TYPE "ActivityLogEntityType" AS ENUM ('USER', 'ROLE', 'STATION', 'CATEGORY', 'PRODUCT');

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "action" "ActivityLogAction" NOT NULL,
    "entityType" "ActivityLogEntityType",
    "entityId" TEXT,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_actorUserId_idx" ON "activity_logs"("actorUserId");

-- CreateIndex
CREATE INDEX "activity_logs_entityType_entityId_idx" ON "activity_logs"("entityType", "entityId");
