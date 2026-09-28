import { z } from "zod";
import { DeliveryOutcomeType, OrderEventType, OrderStatus, ReturnOutcome, ReturnReason } from "../../generated/prisma/enums";
import { orderResponseSchema } from "../orders/orders.schemas";

const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  roleName: z.string().nullable().describe("The actor's current role name — live, not a snapshot of what it was at the time of this event."),
});

const stationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const timelineResponseSchema = z.array(
  z.object({
    id: z.string(),
    type: z.enum(OrderEventType),
    station: stationSummarySchema.nullable(),
    message: z.string().nullable(),
    metadata: z.any().nullable(),
    createdAt: z.date(),
    actor: actorSchema,
  }),
);

const stationVisitSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  stationId: z.string(),
  station: stationSummarySchema.nullable(),
  sequenceNo: z.number(),
  receivedAt: z.date().nullable(),
  receivedByUserId: z.string().nullable(),
  outgoingAt: z.date().nullable(),
  outgoingByUserId: z.string().nullable(),
  isReworkVisit: z.boolean().describe("True when sequenceNo > 1 for this station — i.e. this is a rework or return revisit, not the order's first time here."),
  reworkRouteId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  durationMs: z.number().nullable().describe("outgoingAt - receivedAt in milliseconds. Null while the visit is still open (received but no outgoing logged yet)."),
});

const deliveryOutcomeSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  outcome: z.enum(DeliveryOutcomeType),
  customerConfirmed: z.boolean(),
  returnReason: z.enum(ReturnReason).nullable(),
  returnNote: z.string().nullable().describe("Free-text detail behind returnReason, set only for a RETURNED outcome."),
  responsibleStationId: z.string().nullable(),
  responsibleStation: stationSummarySchema.nullable(),
  courierName: z.string().nullable().describe("Third-party courier name (e.g. \"J&T Express\"), set only for a DELIVERED outcome fulfilled by a courier drop-off. Null for RETURNED and for in-person pickup/hand-off deliveries."),
  waybillNumber: z.string().nullable().describe("The courier's own waybill/tracking number, if courierName was given."),
  recordedByUserId: z.string(),
  createdAt: z.date(),
});

const returnReviewImageSchema = z.object({
  id: z.string(),
  returnReviewId: z.string(),
  url: z.string(),
  createdAt: z.date(),
});

const returnReviewSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  stationVisitId: z.string(),
  outcome: z.enum(ReturnOutcome),
  decidedByUserId: z.string(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  images: z.array(returnReviewImageSchema).describe("Photo evidence attached to this decision, for record purposes."),
});

export const reportResponseSchema = z.object({
  order: orderResponseSchema,
  stationVisits: z.array(stationVisitSchema),
  deliveryOutcomes: z.array(deliveryOutcomeSchema).describe("Usually one row (DELIVERED). More than one means the order was RETURNED and re-delivered at least once — read in createdAt order to follow the history."),
  returnReviews: z.array(returnReviewSchema).describe("Every Return station decision on this order (send to QC / for replacement), oldest first."),
  totalTurnaroundMs: z.number().describe("orderDate to the DELIVERED outcome's timestamp, or to now if isComplete is false."),
  isComplete: z.boolean().describe("True once a DELIVERED outcome exists. False for an order still in progress, including one currently mid-return."),
});

export const salesReportQuerySchema = z.object({
  from: z.coerce.date().optional().describe("Inclusive lower bound on orderDate. Omit for no lower bound."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on orderDate. Omit for no upper bound."),
  groupBy: z.enum(["day", "month"]).default("month").describe("Bucket size for the per-period breakdown."),
  includeArchived: z.coerce.boolean().default(false).describe("Include archived orders (bad/test intakes, or old orders tidied out of the dashboard) in both the buckets and the ledger entries. Defaults to false, matching GET /orders."),
});

const salesReportBucketSchema = z.object({
  period: z.string().describe("Bucket start (UTC), e.g. \"2026-08-01\" for a month bucket or \"2026-08-19\" for a day bucket."),
  orderCount: z.number(),
  revenue: z.number().describe("Sum of (unitPrice - discountAmount) * quantity across every item on every order placed in this bucket."),
  avgOrderValue: z.number().describe("revenue / orderCount for this bucket — average per ORDER, not per item."),
});

const salesReportPartySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});

const salesReportColorLiningSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
});

const salesReportEntryItemSchema = z.object({
  id: z.string(),
  itemNo: z.number().int().describe("Position within the order — \"item 2\", not the internal id."),
  itemCode: z.string().describe("`{orderNumber}-{itemNo}`, e.g. \"RC-2026-000042-2\"."),
  product: salesReportPartySummarySchema,
  colorLining: salesReportColorLiningSummarySchema.nullable(),
  quantity: z.number().int(),
  unitPrice: z.number().describe("Price snapshotted when this item was added, before any per-unit discount."),
  regularPriceAtOrder: z.number().describe("The product's undiscounted price at that same moment, for reference."),
  discountAmount: z.number(),
  discountReason: z.string().nullable(),
  finalPrice: z.number().describe("unitPrice - discountAmount, per unit — multiply by quantity for this line's total."),
});

const salesReportEntrySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  orderDate: z.date(),
  status: z.enum(OrderStatus),
  isArchived: z.boolean(),
  customer: salesReportPartySummarySchema,
  items: z.array(salesReportEntryItemSchema).describe("Every item line on this order."),
  subtotal: z.number().describe("Sum of unitPrice * quantity across every item."),
  totalDiscount: z.number().describe("Sum of discountAmount * quantity across every item."),
  promoCode: z.string().nullable().describe("Promo code applied at intake, if any."),
  promoDiscount: z.number().describe("Peso amount that promo took off (subtotal - totalDiscount). 0 if none."),
  finalPrice: z.number().describe("subtotal - totalDiscount - promoDiscount — the actual amount recorded for this sale."),
  runningBalance: z.number().describe("Cumulative finalPrice total up to and including this order, in orderDate order — the ledger's running balance."),
});

export const salesReportResponseSchema = z.object({
  from: z.date().nullable(),
  to: z.date().nullable(),
  groupBy: z.enum(["day", "month"]),
  includeArchived: z.boolean(),
  totalOrders: z.number(),
  totalRevenue: z.number(),
  avgOrderValue: z.number(),
  buckets: z.array(salesReportBucketSchema).describe("Periodic summary — one row per day/month, for trend charts."),
  entries: z.array(salesReportEntrySchema).describe("Full transaction-level ledger — one row per order in range, oldest first, with a running revenue balance."),
});
