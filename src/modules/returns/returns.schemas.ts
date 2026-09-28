import { z } from "zod";
import { ReturnOutcome } from "../../generated/prisma/enums";

export const returnDecisionBodySchema = z
  .object({
    outcome: z.enum(ReturnOutcome).describe("SEND_TO_QC re-enters the normal QC flow (QC then approves or routes rework as usual). FOR_REPLACEMENT flags the named items for replacement and parks the order at Return until a Supervisor+ issues it."),
    orderItemIds: z.array(z.string()).min(1).optional().describe("Required for FOR_REPLACEMENT: which item(s) on this order need replacing. Every id must reference an item on this order."),
    notes: z.string().min(1).optional(),
  })
  .refine((data) => data.outcome !== ReturnOutcome.FOR_REPLACEMENT || data.orderItemIds !== undefined, {
    message: "orderItemIds is required when outcome is FOR_REPLACEMENT",
    path: ["orderItemIds"],
  })
  .refine((data) => data.outcome === ReturnOutcome.FOR_REPLACEMENT || data.orderItemIds === undefined, {
    message: "orderItemIds only applies when outcome is FOR_REPLACEMENT",
    path: ["orderItemIds"],
  });

export const issueReplacementBodySchema = z.object({
  notes: z.string().min(1).optional().describe("Free-text note for the order timeline."),
});

export const returnReviewImageParamsSchema = z.object({ id: z.string(), reviewId: z.string() });
export const returnReviewImageIdParamsSchema = z.object({ id: z.string(), reviewId: z.string(), imageId: z.string() });

export const addReturnReviewImageBodySchema = z.object({
  url: z.string().min(1).describe("Must point to an already-hosted image — use the /upload variant to host it here instead."),
});

const returnReviewImageSchema = z.object({
  id: z.string(),
  returnReviewId: z.string(),
  url: z.string(),
  createdAt: z.date(),
});

export const returnReviewResponseSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  stationVisitId: z.string(),
  outcome: z.enum(ReturnOutcome),
  decidedByUserId: z.string(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  images: z.array(returnReviewImageSchema).describe("Photo evidence of the returned item's condition, for record purposes — uploaded or linked after the decision was submitted."),
});
