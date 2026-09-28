import { z } from "zod";
import { DeliveryOutcomeType, ReturnReason } from "../../generated/prisma/enums";

export const deliveryOutcomeBodySchema = z
  .object({
    outcome: z.enum(DeliveryOutcomeType),
    customerConfirmed: z.boolean().optional().describe("Required true when outcome is DELIVERED — this endpoint won't mark it delivered without an explicit customer confirmation."),
    returnReason: z.enum(ReturnReason).optional().describe("Required when outcome is RETURNED: DEFECT, DISSATISFACTION, or MISSING_OR_LACKING. A RETURNED outcome always routes the order to the fixed Return station, which then decides send-to-QC or for-replacement (POST /orders/:id/return-decision)."),
    returnNote: z.string().min(1).optional().describe("Only valid when outcome is RETURNED. Free-text detail behind returnReason, e.g. \"Loose stitching on the left bolster\" — shown in the returns report."),
    courierName: z.string().min(1).optional().describe("Third-party courier name (e.g. \"J&T Express\", \"LBC\", \"Lalamove\") when this delivery was a courier drop-off rather than an in-person pickup/hand-off. Omit for pickup/hand-off deliveries."),
    waybillNumber: z.string().min(1).optional().describe("The courier's own waybill/tracking number, for customer-facing tracking or dispute lookup."),
  })
  .refine((data) => data.outcome !== DeliveryOutcomeType.DELIVERED || data.customerConfirmed === true, {
    message: "customerConfirmed must be true when outcome is DELIVERED",
    path: ["customerConfirmed"],
  })
  .refine((data) => data.outcome !== DeliveryOutcomeType.RETURNED || data.returnReason !== undefined, {
    message: "returnReason is required when outcome is RETURNED",
    path: ["returnReason"],
  })
  .refine((data) => data.outcome === DeliveryOutcomeType.RETURNED || data.returnNote === undefined, {
    message: "returnNote only applies when outcome is RETURNED",
    path: ["returnNote"],
  });

export const deliveredReportQuerySchema = z.object({
  from: z.coerce.date().optional().describe("Inclusive lower bound on when the delivery was recorded (DeliveryOutcome.createdAt). Omit for no lower bound."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on when the delivery was recorded. Omit for no upper bound."),
  courierName: z.string().min(1).optional().describe("Case-insensitive partial match, e.g. \"j&t\" matches \"J&T Express\". Omit to include every delivery regardless of courier, including in-person pickup/hand-off (courierName null)."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const deliveredReportCustomerSchema = z.object({ id: z.string(), name: z.string() });
const deliveredReportProductSchema = z.object({ id: z.string(), name: z.string() });
const deliveredReportColorLiningSchema = z.object({ id: z.string(), label: z.string() });
const deliveredReportActorSchema = z.object({ id: z.string(), name: z.string(), roleName: z.string().nullable() });

const deliveredReportItemSchema = z.object({
  id: z.string(),
  itemNo: z.number().int().describe("Position within the order — \"item 2\", not the internal id."),
  itemCode: z.string().describe("`{orderNumber}-{itemNo}`, e.g. \"RC-2026-000042-2\"."),
  product: deliveredReportProductSchema,
  colorLining: deliveredReportColorLiningSchema.nullable(),
  quantity: z.number().int(),
});

const deliveredReportEntrySchema = z.object({
  deliveryOutcomeId: z.string(),
  order: z.object({
    id: z.string(),
    orderNumber: z.string(),
    orderDate: z.date(),
    customer: deliveredReportCustomerSchema,
  }),
  items: z.array(deliveredReportItemSchema).describe("Every item line on the order that was delivered."),
  customerConfirmed: z.boolean(),
  courierName: z.string().nullable().describe("Null for an in-person pickup/hand-off delivery."),
  waybillNumber: z.string().nullable(),
  deliveredAt: z.date().describe("When this delivery outcome was recorded (DeliveryOutcome.createdAt)."),
  recordedBy: deliveredReportActorSchema,
});

export const deliveredReportResponseSchema = z.object({
  from: z.date().nullable(),
  to: z.date().nullable(),
  courierName: z.string().nullable(),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(deliveredReportEntrySchema).describe("Newest delivery first."),
});
