import { z } from "zod";

export const scanBodySchema = z.object({
  qrToken: z.string().min(1).describe("Read off the order's printed QR tag — this is Order.qrToken, not orderNumber."),
  stationId: z.string().min(1).describe("Which physical station this scan is happening at — typically fixed per kiosk/device rather than chosen per scan."),
});

export const rejectBodySchema = z.object({
  qrToken: z.string().min(1).describe("Read off the order's printed QR tag — this is Order.qrToken, not orderNumber."),
  stationId: z.string().min(1).describe("Which physical station this rejection is happening at — must be where the order is currently checked in."),
  rejectionReasonId: z.string().min(1).optional().describe("Must reference an active QC rejection reason (see GET /qc-rejection-reasons) — same categorization used by qc-decision's REWORK path and the QC metrics report."),
  reason: z.string().min(1).optional().describe('Free-text detail, e.g. "seam gap on left panel" — shown in the order timeline.'),
  orderItemIds: z.array(z.string()).min(1).optional().describe("Which specific item(s) on this order had the defect, if the rejection is about a specific item rather than the whole order. Every id must reference an item on this order."),
});

export const itemProgressBodySchema = z.object({
  qrToken: z.string().min(1).describe("Read off the order's printed QR tag — this is Order.qrToken, not orderNumber."),
  stationId: z.string().min(1).describe("Which station this checklist toggle applies to — the order must be currently checked in here."),
  orderItemId: z.string().min(1).describe("Must reference an item on this order."),
  isFinished: z.boolean().describe("Purely informational — does not gate the outgoing scan. Scoped to the order's current StationVisit at this station: a rework revisit starts every item back at not-finished."),
});

export const itemProgressResponseSchema = z.object({
  orderItemId: z.string(),
  stationVisitId: z.string(),
  isFinished: z.boolean(),
  finishedAt: z.date().nullable(),
});
