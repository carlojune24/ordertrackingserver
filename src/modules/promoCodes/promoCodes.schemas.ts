import { z } from "zod";
import { PromoDiscountType } from "../../generated/prisma/enums";

const promoFieldsSchema = z.object({
  description: z.string().min(1).optional(),
  discountType: z.enum(PromoDiscountType).describe("PERCENT = value is a % off the order (after item discounts). FIXED = value is a flat peso amount off, never more than the order total."),
  value: z.number().positive().describe("Percent (max 100) for PERCENT, peso amount for FIXED."),
  startsAt: z.coerce.date().optional().describe("Not redeemable before this. Omit for immediately."),
  expiresAt: z.coerce.date().optional().describe("Not redeemable after this. Omit for no expiry."),
  maxUses: z.number().int().positive().optional().describe("Total redemptions allowed across all orders. Omit for unlimited."),
});

export const createPromoCodeBodySchema = promoFieldsSchema
  .extend({
    code: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, "code may only contain letters, numbers, hyphens and underscores")
      .describe("Stored uppercase; staff can type it in any case at intake."),
  })
  .refine((d) => d.discountType !== "PERCENT" || d.value <= 100, { message: "A PERCENT promo cannot exceed 100", path: ["value"] })
  .refine((d) => !d.startsAt || !d.expiresAt || d.startsAt < d.expiresAt, { message: "expiresAt must be after startsAt", path: ["expiresAt"] });

export const updatePromoCodeBodySchema = z.object({
  description: z.string().min(1).nullable().optional(),
  discountType: z.enum(PromoDiscountType).optional(),
  value: z.number().positive().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional().describe("Set false to retire the code. Orders that already used it are unaffected."),
});

export const listPromoCodesQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional().describe("Include retired codes — off by default."),
});

export const promoCodeIdParamsSchema = z.object({ id: z.string() });

export const promoCodeResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  discountType: z.enum(PromoDiscountType),
  value: z.number(),
  startsAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  maxUses: z.number().nullable(),
  usesCount: z.number(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const promoCodeListResponseSchema = z.array(promoCodeResponseSchema);
