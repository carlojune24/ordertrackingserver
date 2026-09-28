import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { PromoDiscountType } from "../../generated/prisma/enums";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";

export function normalizePromoCode(code: string) {
  return code.trim().toUpperCase();
}

export function listPromoCodes(prisma: PrismaClient, includeInactive?: boolean) {
  return prisma.promoCode.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

export interface CreatePromoCodeInput {
  code: string;
  description?: string;
  discountType: PromoDiscountType;
  value: number;
  startsAt?: Date;
  expiresAt?: Date;
  maxUses?: number;
}

export async function createPromoCode(prisma: PrismaClient, actorUserId: string, input: CreatePromoCodeInput) {
  const code = normalizePromoCode(input.code);
  if (await prisma.promoCode.findUnique({ where: { code } })) {
    throw new ValidationError("A promo code with this code already exists");
  }

  return prisma.$transaction(async (tx) => {
    const promo = await tx.promoCode.create({
      data: {
        code,
        description: input.description,
        discountType: input.discountType,
        value: input.value,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
      },
    });
    await recordActivity(tx, {
      action: "CREATED",
      entityType: "PROMO_CODE",
      entityId: promo.id,
      actorUserId,
      message: `Promo code ${promo.code} created.`,
    });
    return promo;
  });
}

export interface UpdatePromoCodeInput {
  description?: string | null;
  discountType?: PromoDiscountType;
  value?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
  isActive?: boolean;
}

export async function updatePromoCode(prisma: PrismaClient, id: string, actorUserId: string, input: UpdatePromoCodeInput) {
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Promo code not found");

  const type = input.discountType ?? existing.discountType;
  const value = input.value ?? existing.value;
  if (type === "PERCENT" && value > 100) throw new ValidationError("A PERCENT promo cannot exceed 100");

  const startsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt;
  const expiresAt = input.expiresAt === undefined ? existing.expiresAt : input.expiresAt;
  if (startsAt && expiresAt && startsAt >= expiresAt) throw new ValidationError("expiresAt must be after startsAt");

  if (input.maxUses != null && input.maxUses < existing.usesCount) {
    throw new ValidationError(`maxUses cannot be lower than the ${existing.usesCount} redemptions already made`);
  }

  return prisma.$transaction(async (tx) => {
    const promo = await tx.promoCode.update({ where: { id }, data: input });
    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "PROMO_CODE",
      entityId: promo.id,
      actorUserId,
      message: `Promo code ${promo.code} updated.`,
    });
    return promo;
  });
}

/** Validates a typed-in code and atomically claims one use, inside the caller's intake
 * transaction so a failed order never burns a redemption. The conditional updateMany is what
 * makes maxUses race-safe — two concurrent intakes can't both take the last use. */
export async function redeemPromoCode(tx: Prisma.TransactionClient, rawCode: string) {
  const promo = await tx.promoCode.findUnique({ where: { code: normalizePromoCode(rawCode) } });
  const now = new Date();
  if (
    !promo ||
    !promo.isActive ||
    (promo.startsAt && promo.startsAt > now) ||
    (promo.expiresAt && promo.expiresAt < now)
  ) {
    throw new ValidationError("Promo code is invalid or not currently active");
  }

  const claimed = await tx.promoCode.updateMany({
    where: promo.maxUses == null ? { id: promo.id } : { id: promo.id, usesCount: { lt: promo.maxUses } },
    data: { usesCount: { increment: 1 } },
  });
  if (claimed.count === 0) throw new ValidationError("Promo code has reached its maximum number of uses");

  return promo;
}
