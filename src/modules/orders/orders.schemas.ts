import { z } from "zod";
import { OrderStatus, PromoDiscountType, ReplacementStatus } from "../../generated/prisma/enums";
import { customerSummarySchema } from "../customers/customers.schemas";

const intakeItemBodySchema = z.object({
  productId: z.string().describe("Must reference an active Product. Its current price is snapshotted onto this item."),
  colorLiningId: z.string().optional().describe("Required if the product has any active color linings; must be omitted if it has none."),
  quantity: z.number().int().positive().optional().describe("Defaults to 1. Repeated identical items (e.g. 3 of the same shirt) are one line with quantity 3, not 3 separate lines."),
  isCustomized: z.boolean().optional().describe("Regular (false, default) or customized (true) version of the product. Drives which of Product.regularPrice/customizedPrice unitPrice auto-fills from — override unitPrice directly to charge something else regardless of this flag."),
  unitPrice: z.number().min(0).optional().describe("Overrides the auto-derived price (Product.customizedPrice if isCustomized, else regularPrice). Omit to use the auto-derived price."),
  discountAmount: z.number().min(0).optional().describe("A per-unit discount on top of this item's unitPrice. Must be between 0 and unitPrice. Defaults to 0."),
  discountReason: z.string().min(1).optional().describe("Free-text note, e.g. \"loyalty customer\" — recommended for accountability when discountAmount > 0."),
  note: z.string().min(1).optional().describe("Free-text note on this specific line item (sizing, special instructions, etc.) — unrelated to pricing."),
});

export const intakeBodySchema = z.object({
  customerId: z.string().describe("Must reference an existing Customer — create one first via POST /customers if they're not already on file. There is no free-text customer entry at intake."),
  items: z.array(intakeItemBodySchema).min(1).describe("Every product line in this order. An order must have at least one item; add more later via POST /orders/:id/items."),
  proposedDurationDays: z.number().int().positive().describe("Used to compute deadline = orderDate + proposedDurationDays."),
  priority: z.number().int().positive().optional().describe("P-number — lower is more urgent (P1 = highest). Omit for unflagged; dashboard sorts unflagged orders last."),
  promoCode: z.string().min(1).optional().describe("Optional promo code, any case. Validated (active, within dates, uses remaining) and redeemed atomically with the order — an invalid code 400s and no order is created. Applied as an order-level discount on top of any item discounts; cannot be added or changed after intake."),
  downPayment: z.number().min(0).optional().describe("Amount the customer is paying up front. Defaults to 0. Must not exceed the order's computed finalPrice (400 otherwise)."),
});

export const updateOrderBodySchema = z.object({
  customerId: z.string().optional().describe("Re-points this order at a different existing Customer. Must reference an active (non-archived) customer."),
  proposedDurationDays: z.number().int().positive().optional().describe("Recomputes deadline from the original orderDate, not from now."),
  priority: z.number().int().positive().nullable().optional(),
  downPayment: z.number().min(0).optional().describe("Updates the amount already paid toward this order. Must not exceed the order's current finalPrice (400 otherwise). Writes a DOWN_PAYMENT_UPDATED timeline event when changed."),
});

export const orderItemBodySchema = intakeItemBodySchema;

export const updateOrderItemBodySchema = z.object({
  productId: z.string().optional().describe("Changing this re-snapshots unitPrice/regularPriceAtOrder from the new product's current price, unless unitPrice is also given."),
  colorLiningId: z.string().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  isCustomized: z.boolean().optional().describe("Flipping this re-snapshots unitPrice/regularPriceAtOrder from Product.regularPrice/customizedPrice, unless unitPrice is also given."),
  unitPrice: z.number().min(0).optional().describe("Overrides the auto-derived price directly, regardless of productId/isCustomized changes."),
  discountAmount: z
    .number()
    .min(0)
    .optional()
    .describe("A per-unit discount on top of this item's unitPrice. Must be between 0 and the item's current unitPrice."),
  discountReason: z.string().min(1).nullable().optional().describe("Free-text note, e.g. \"loyalty customer\" — recommended for accountability when discountAmount > 0."),
  note: z.string().min(1).nullable().optional().describe("Free-text note on this specific line item (sizing, special instructions, etc.) — unrelated to pricing."),
});

export const orderItemIdParamsSchema = z.object({ id: z.string(), itemId: z.string() });

export const listOrdersQuerySchema = z.object({
  status: z.enum(OrderStatus).optional().describe("IN_PROGRESS or DELIVERED. Note RETURNED isn't a status — it's an event that re-routes the order back into IN_PROGRESS at the responsible station."),
  stationId: z.string().optional().describe("Filter to orders currently at (or in transit toward) this exact station."),
  isCheckedIn: z.coerce.boolean().optional().describe("true = physically received at stationId (awaiting outgoing); false = in transit toward it. Combine with stationId to see who's actually standing at a station right now."),
  priority: z.coerce.number().int().positive().optional().describe("Exact match on the P-number, not \"at least this urgent\"."),
  overdue: z.coerce.boolean().optional().describe("true = deadline has passed and the order isn't DELIVERED yet."),
  categoryId: z.string().optional().describe("Filter to orders whose product belongs to this car brand."),
  customerId: z.string().optional().describe("Filter to every order placed by this customer — this is how order history/count-per-customer is answered (alongside orderCount on GET /customers/:id for the quick total)."),
  search: z.string().min(1).optional().describe("Matches order number, customer name, or product name, case-insensitive."),
  includeArchived: z.coerce.boolean().optional().describe("Archived orders are excluded by default. Set true to include them alongside active orders in the listing."),
  pendingReplacement: z.coerce.boolean().optional().describe("true = only orders with at least one item flagged FOR_REPLACEMENT and not yet issued."),
  archivedOnly: z.coerce.boolean().optional().describe("Show only archived orders — for an admin 'Archived Orders' view. Overrides includeArchived when both are set."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const orderIdParamsSchema = z.object({ id: z.string() });

export const overrideStationBodySchema = z.object({
  stationId: z.string().describe("Must reference an active station — dynamic or system (QC/Packaging/Courier). Marks the order as checked in there immediately."),
  assignedWorkerUserId: z
    .string()
    .nullable()
    .optional()
    .describe("Pins the order to one specific worker, who must already be assigned to stationId. Omit or pass null to leave unpinned — a pin never carries over from a previous override."),
  reason: z.string().min(1).optional().describe("Free-text note for the audit trail, e.g. \"mis-scanned at Sewing, correcting.\""),
});

const productSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
});

const colorLiningSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
});

const stationWorkerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  roleName: z.string(),
});

const assignedWorkerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});

const stationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  colorHex: z.string().nullable(),
  isQcCheckpoint: z.boolean(),
  isSystem: z.boolean(),
  assignedWorkers: z.array(stationWorkerSummarySchema).describe("Active users currently assigned to this station (User.assignedStationId) — who's in charge of the order right now, not just where it is. Usually 0 or 1, but not constrained to be."),
});

export const orderItemDtoSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  itemNo: z.number().int().describe("Position within the order (1, 2, 3…), assigned once at creation and never reused or renumbered — even after another item on the order is removed. Combine with the order's orderNumber yourself, or just use itemCode below."),
  itemCode: z.string().describe("`{orderNumber}-{itemNo}`, e.g. \"RC-2026-000042-2\" — a short, human-readable label for this specific item, for staff to reference on paper tags or verbally instead of the internal id."),
  productId: z.string(),
  product: productSummarySchema,
  colorLiningId: z.string().nullable(),
  colorLining: colorLiningSummarySchema.nullable(),
  quantity: z.number().int(),
  isCustomized: z.boolean().describe("Regular (false) or customized (true) version of the product — drove the auto-filled unitPrice/regularPriceAtOrder below, though unitPrice may since have been overridden."),
  unitPrice: z.number().describe("What was actually charged when this item was added (Product.customizedPrice if isCustomized, else regularPrice) — or an explicit override. Frozen — later product price changes never affect this."),
  regularPriceAtOrder: z.number().describe("The product's undiscounted price for this item's regular/customized selection at that same moment, for reference. regularPriceAtOrder - unitPrice = the discount given."),
  discountAmount: z.number().describe("A per-unit discount on top of unitPrice, set via the item endpoints. 0 if none."),
  discountReason: z.string().nullable(),
  note: z.string().nullable().describe("Free-text note on this specific line item (sizing, special instructions, etc.) — unrelated to pricing."),
  replacementStatus: z.enum(ReplacementStatus).describe("NONE normally. FLAGGED = the Return station marked this item for replacement, awaiting a Supervisor+ to issue it. ISSUED = a replacement was issued (history — the order looped back to the first station)."),
  replacementFlaggedAt: z.date().nullable(),
  replacementIssuedAt: z.date().nullable(),
  finalPrice: z.number().describe("unitPrice - discountAmount, per unit — multiply by quantity for this line's total. Computed on read, not stored."),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const orderDtoSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  qrToken: z.string(),
  customerId: z.string(),
  customer: customerSummarySchema,
  items: z.array(orderItemDtoSchema).describe("Every product line on this order. The order itself still moves through production as one shared physical unit — items don't move independently, see currentStation/isCheckedIn below."),
  hasPendingReplacement: z.boolean().describe("True while any item is FLAGGED for replacement and not yet issued — the 'for replacement' flag for Admin > Orders."),
  subtotal: z.number().describe("Sum of unitPrice * quantity across every item."),
  totalDiscount: z.number().describe("Sum of discountAmount * quantity across every item."),
  promoCode: z.string().nullable().describe("The promo code applied at intake, if any — a snapshot, unaffected by later edits to the PromoCode."),
  promoType: z.enum(PromoDiscountType).nullable(),
  promoValue: z.number().nullable().describe("Percent for PERCENT, peso amount for FIXED, as snapshotted at intake."),
  promoDiscount: z.number().describe("Peso amount the promo takes off (subtotal - totalDiscount), computed on read so it tracks later item changes. 0 if no promo."),
  finalPrice: z.number().describe("subtotal - totalDiscount - promoDiscount — what the customer actually pays. Computed on read, not stored."),
  downPayment: z.number().describe("Amount already paid toward finalPrice. 0 if none. Automatically lowered to match finalPrice if a later item edit/removal drops finalPrice below it — never negative, never more than finalPrice."),
  orderDate: z.date(),
  proposedDurationDays: z.number(),
  deadline: z.date(),
  priority: z.number().nullable(),
  status: z.enum(OrderStatus).describe("IN_PROGRESS or DELIVERED. The only real terminal state — a return re-enters IN_PROGRESS rather than having its own status."),
  currentStationId: z.string().nullable().describe("Null only once status is DELIVERED. Otherwise always points at a station — the one currently expected next (if isCheckedIn is false) or physically occupied (if true)."),
  currentStation: stationSummarySchema.nullable(),
  isCheckedIn: z.boolean().describe("true = physically received at currentStation, awaiting outgoing. false = in transit toward it, awaiting a receive scan."),
  assignedWorkerUserId: z.string().nullable().describe("Pins the order to one specific worker — distinct from currentStation.assignedWorkers (everyone assigned to the station generally). Set via the admin station-override action, or automatically on a QC rework decision to whoever last received the order at the rework target station."),
  assignedWorker: assignedWorkerSummarySchema.nullable(),
  isOverdue: z.boolean(),
  isArchived: z.boolean().describe("Archived orders are fully frozen (edit/scan/QC/delivery all rejected) and excluded from GET /orders by default."),
  archivedAt: z.date().nullable(),
  createdByUserId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const orderResponseSchema = orderDtoSchema;
export const orderListResponseSchema = z.object({
  items: z.array(orderDtoSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
