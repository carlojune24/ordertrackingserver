import { z } from "zod";
import { QcOutcome } from "../../generated/prisma/enums";

export const qcDecisionBodySchema = z
  .object({
    outcome: z.enum(QcOutcome).describe("APPROVED advances to the next station. REWORK sends it back."),
    targetStationId: z.string().min(1).optional().describe("Required for REWORK. Must be an active station with an earlier sortOrder than the checkpoint the order is currently at — validated server-side, not just client-side."),
    rejectionReasonId: z.string().min(1).optional().describe("Only valid for REWORK. Must reference an active QC rejection reason (see GET /qc-rejection-reasons) — structured categorization used by the QC metrics report, additive to the free-text `reason` below."),
    reason: z.string().min(1).optional().describe('Why the rework is needed, e.g. "stitching loose" — shown in the order timeline.'),
    notes: z.string().min(1).optional(),
    orderItemIds: z.array(z.string()).min(1).optional().describe("Only valid for REWORK. Which specific item(s) on this order had the defect, if the rework is about a specific item rather than the whole order. Every id must reference an item on this order."),
  })
  .refine((data) => data.outcome !== QcOutcome.REWORK || data.targetStationId !== undefined, {
    message: "targetStationId is required when outcome is REWORK",
    path: ["targetStationId"],
  })
  .refine((data) => data.outcome === QcOutcome.REWORK || data.rejectionReasonId === undefined, {
    message: "rejectionReasonId only applies when outcome is REWORK",
    path: ["rejectionReasonId"],
  })
  .refine((data) => data.outcome === QcOutcome.REWORK || data.orderItemIds === undefined, {
    message: "orderItemIds only applies when outcome is REWORK",
    path: ["orderItemIds"],
  });

const qcActorSchema = z.object({
  id: z.string(),
  name: z.string(),
  roleName: z.string().nullable(),
});

const qcStationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const qcRejectionReasonSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const qcColorLiningSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
});

const qcReworkItemSummarySchema = z.object({
  id: z.string(),
  itemNo: z.number().int().describe("Position within the order — \"item 2\", not the internal id."),
  product: z.object({ id: z.string(), name: z.string() }),
  colorLining: qcColorLiningSummarySchema.nullable(),
  quantity: z.number().int(),
});

export const qcReviewResponseSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  outcome: z.enum(QcOutcome),
  station: qcStationSummarySchema.nullable().describe("The QC checkpoint station this review happened at, resolved via stationVisitId."),
  notes: z.string().nullable(),
  reviewedBy: qcActorSchema,
  createdAt: z.date(),
  rework: z
    .object({
      targetStation: qcStationSummarySchema,
      reason: z.string().nullable(),
      rejectionReason: qcRejectionReasonSummarySchema.nullable(),
      items: z.array(qcReworkItemSummarySchema).describe("Which specific item(s) on the order were flagged as defective. Empty if the rework wasn't tied to a specific item."),
    })
    .nullable()
    .describe("Present only when outcome is REWORK — the associated ReworkRoute detail."),
});

export const qcReviewListResponseSchema = z.array(qcReviewResponseSchema);

const qcReviewOrderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
});

export const qcReviewForUserResponseSchema = qcReviewResponseSchema
  .omit({ orderId: true })
  .extend({ order: qcReviewOrderSummarySchema });

export const qcReviewsForUserQuerySchema = z.object({
  outcome: z.enum(QcOutcome).optional().describe("Filter to only APPROVED or only REWORK decisions. Omit for both."),
  from: z.coerce.date().optional().describe("Inclusive lower bound on when the QC decision was recorded. Omit for no lower bound."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on when the QC decision was recorded. Omit for no upper bound."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const qcReviewsForUserListResponseSchema = z.object({
  items: z.array(qcReviewForUserResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const qcReportQuerySchema = z.object({
  from: z.coerce.date().optional().describe("Inclusive lower bound on when the QC decision was recorded. Omit for no lower bound."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on when the QC decision was recorded. Omit for no upper bound."),
});

const qcReportStationBreakdownSchema = z.object({
  station: qcStationSummarySchema,
  reworkCount: z.number(),
});

const qcReportReasonBreakdownSchema = z.object({
  rejectionReason: qcRejectionReasonSummarySchema.nullable().describe("Null groups reworks that were routed without a rejectionReasonId — shown as an 'Uncategorized' bucket."),
  reworkCount: z.number(),
});

export const qcReportResponseSchema = z.object({
  from: z.date().nullable(),
  to: z.date().nullable(),
  totalReviews: z.number().describe("Formal QC-checkpoint decisions only (QcReview rows) — does not include a regular station's own rejection via POST /scan/reject, which never creates a QcReview."),
  approvedCount: z.number().describe("QC-checkpoint APPROVED decisions only, same scope as totalReviews."),
  reworkCount: z.number().describe("QC-checkpoint REWORK decisions only, same scope as totalReviews — will read lower than the sum of byStation/byRejectionReason below whenever any regular station has also rejected an order via POST /scan/reject."),
  reworkRatePercent: z.number().describe("reworkCount / totalReviews * 100, 0 if totalReviews is 0 — QC-checkpoint rate only, same scope as reworkCount."),
  byStation: z.array(qcReportStationBreakdownSchema).describe("Rework counts grouped by the target station reworked to — i.e. which station's work most often needs redoing. Unlike totalReviews/reworkCount above, this covers every ReworkRoute regardless of origin: both QC-checkpoint REWORK decisions and regular stations' own rejections via POST /scan/reject. Sorted highest first."),
  byRejectionReason: z.array(qcReportReasonBreakdownSchema).describe("Rework counts grouped by rejection-reason category. Same full scope as byStation — QC and regular-station rejections both included. Sorted highest first."),
});
