import type { Prisma, PrismaClient } from "../generated/prisma/client";
import type { ActivityLogAction, ActivityLogEntityType } from "../generated/prisma/enums";

export interface RecordActivityInput {
  action: ActivityLogAction;
  entityType?: ActivityLogEntityType;
  entityId?: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  message?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Writes one ActivityLog row. Admin/config call sites pass a Prisma.TransactionClient
 * (always inside the mutation's own $transaction, same convention as OrderEvent). Auth call
 * sites pass the bare PrismaClient — a login/logout check has no separate mutation to stay
 * atomic with, except the refresh-reuse-detection case, which uses a transaction explicitly. */
export function recordActivity(tx: Prisma.TransactionClient | PrismaClient, input: RecordActivityInput) {
  return tx.activityLog.create({ data: input });
}
