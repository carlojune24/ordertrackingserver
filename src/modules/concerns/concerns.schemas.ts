import { z } from "zod";
import { OrderConcernType } from "../../generated/prisma/enums";
import { orderIdParamsSchema } from "../orders/orders.schemas";

export const raiseConcernBodySchema = z.object({
  type: z.enum(OrderConcernType),
  message: z.string().min(1),
});

export const resolveConcernBodySchema = z.object({
  resolutionNote: z.string().min(1).optional(),
});

export const concernIdParamsSchema = orderIdParamsSchema.extend({
  concernId: z.string(),
});

const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  roleName: z.string().nullable(),
});

const stationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const concernResponseSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  station: stationSummarySchema,
  stationVisitId: z.string().nullable(),
  type: z.enum(OrderConcernType),
  message: z.string(),
  raisedBy: actorSchema,
  isResolved: z.boolean(),
  resolvedBy: actorSchema.nullable(),
  resolutionNote: z.string().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
});

export const concernListResponseSchema = z.array(concernResponseSchema);

const concernOrderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
});

export const concernWithOrderResponseSchema = concernResponseSchema.extend({
  order: concernOrderSummarySchema,
});

export const allConcernsQuerySchema = z.object({
  // Deliberately not z.coerce.boolean() — Boolean("false") is true in JS, which would make
  // ?isResolved=false (the primary intended use, an "open concerns" panel) silently return
  // resolved concerns instead. Parse the literal string values instead.
  isResolved: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true"))
    .describe("Filter to only open (false) or only resolved (true) concerns. Omit for both — e.g. for a cross-order 'open concerns' panel, pass isResolved=false."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const allConcernsResponseSchema = z.object({
  items: z.array(concernWithOrderResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
