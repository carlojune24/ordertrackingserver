import type { PrismaClient } from "../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";
import { slugify } from "../../lib/slugify";

export function listQcRejectionReasons(prisma: PrismaClient, includeInactive?: boolean) {
  return prisma.qcRejectionReason.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function assertActiveQcRejectionReason(prisma: PrismaClient, id: string) {
  const reason = await prisma.qcRejectionReason.findUnique({ where: { id } });
  if (!reason || !reason.isActive) {
    throw new ValidationError("rejectionReasonId does not reference an active QC rejection reason");
  }
}

export interface CreateQcRejectionReasonInput {
  name: string;
  slug?: string;
}

export async function createQcRejectionReason(prisma: PrismaClient, actorUserId: string, input: CreateQcRejectionReasonInput) {
  const slug = input.slug ?? slugify(input.name);

  const existing = await prisma.qcRejectionReason.findFirst({ where: { OR: [{ name: input.name }, { slug }] } });
  if (existing) {
    throw new ValidationError("A QC rejection reason with this name or slug already exists");
  }

  return prisma.$transaction(async (tx) => {
    const reason = await tx.qcRejectionReason.create({ data: { name: input.name, slug } });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "QC_REJECTION_REASON",
      entityId: reason.id,
      actorUserId,
      message: `QC rejection reason ${reason.name} created.`,
    });

    return reason;
  });
}

export interface UpdateQcRejectionReasonInput {
  name?: string;
  slug?: string;
  isActive?: boolean;
}

export async function updateQcRejectionReason(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  input: UpdateQcRejectionReasonInput,
) {
  const existing = await prisma.qcRejectionReason.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("QC rejection reason not found");

  if (input.name || input.slug) {
    const conflict = await prisma.qcRejectionReason.findFirst({
      where: {
        id: { not: id },
        OR: [input.name ? { name: input.name } : undefined, input.slug ? { slug: input.slug } : undefined].filter(
          Boolean,
        ) as object[],
      },
    });
    if (conflict) throw new ValidationError("A QC rejection reason with this name or slug already exists");
  }

  return prisma.$transaction(async (tx) => {
    const reason = await tx.qcRejectionReason.update({
      where: { id },
      data: { name: input.name, slug: input.slug, isActive: input.isActive },
    });

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "QC_REJECTION_REASON",
      entityId: reason.id,
      actorUserId,
      message: `QC rejection reason ${reason.name} updated.`,
    });

    return reason;
  });
}
