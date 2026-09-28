import { z } from "zod";
import { ReturnReason } from "../../generated/prisma/enums";

export const returnsReportQuerySchema = z.object({
  from: z.coerce.date().optional().describe("Inclusive lower bound on when the return was recorded at delivery (DeliveryOutcome.createdAt). Omit for no lower bound (\"All time\")."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on when the return was recorded. Omit for no upper bound."),
  returnReason: z.enum(ReturnReason).optional().describe("Filter to one reason."),
  categoryId: z.string().optional().describe("Filter to returns whose order contains at least one product in this category (car brand)."),
  search: z.string().min(1).optional().describe("Matches order number, customer name or product name, case-insensitive."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const returnStatusSchema = z.enum(["ON_THE_WAY_BACK", "AT_RETURN", "SENT_TO_QC", "FOR_REPLACEMENT", "REPLACEMENT_ISSUED", "CLOSED"]);

const idNameSchema = z.object({ id: z.string(), name: z.string() });

const returnEntryItemSchema = z.object({
  id: z.string(),
  itemNo: z.number().int(),
  itemCode: z.string(),
  product: idNameSchema,
  category: idNameSchema,
  colorLining: z.object({ id: z.string(), label: z.string() }).nullable(),
  quantity: z.number().int(),
  replacementStatus: z.enum(["NONE", "FLAGGED", "ISSUED"]),
});

const returnEntrySchema = z.object({
  deliveryOutcomeId: z.string(),
  returnedAt: z.date().describe("When Returned was recorded at delivery."),
  order: z.object({ id: z.string(), orderNumber: z.string(), customer: idNameSchema }),
  items: z.array(returnEntryItemSchema).describe("Every item line on the order."),
  units: z.number().int().describe("Sum of item quantities on the order."),
  returnReason: z.enum(ReturnReason).nullable(),
  returnNote: z.string().nullable(),
  handledBy: z.object({ id: z.string(), name: z.string(), roleName: z.string().nullable() }).describe("Who recorded the return at delivery."),
  courierName: z.string().nullable(),
  waybillNumber: z.string().nullable(),
  status: returnStatusSchema.describe("ON_THE_WAY_BACK = routed to Return, not yet received. AT_RETURN = received at Return, no decision yet. SENT_TO_QC = Return sent it to QC. FOR_REPLACEMENT = flagged, awaiting a Supervisor+ to issue. REPLACEMENT_ISSUED = looped back to the first station. CLOSED = an older return on an order that has since been returned again."),
});

export const returnsReportResponseSchema = z.object({
  from: z.date().nullable(),
  to: z.date().nullable(),
  summary: z.object({
    totalReturns: z.number().describe("Returns matching the filters (one per RETURNED delivery outcome)."),
    totalUnits: z.number(),
    topReason: z.object({ reason: z.enum(ReturnReason), count: z.number() }).nullable(),
    topCategory: z.object({ category: idNameSchema, units: z.number() }).nullable(),
  }),
  byReason: z.array(z.object({ reason: z.enum(ReturnReason), count: z.number() })).describe("Number of returns per reason, highest first."),
  byCategory: z.array(z.object({ category: idNameSchema, units: z.number() })).describe("Units returned per product category (car brand), highest first."),
  topProducts: z.array(z.object({ product: idNameSchema, units: z.number() })).describe("Top 5 most returned products by units."),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(returnEntrySchema).describe("Newest return first."),
});
