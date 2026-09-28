import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  qcDecisionBodySchema,
  qcReportQuerySchema,
  qcReportResponseSchema,
  qcReviewListResponseSchema,
} from "./qc.schemas";
import { getQcReport, listQcReviewsForOrder, submitQcDecision } from "./qc.service";
import { orderIdParamsSchema, orderResponseSchema } from "../orders/orders.schemas";
import { toOrderDto } from "../orders/orders.service";

export default async function qcRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const staffPlus = fastify.authorize("qc.decide");
  const reportView = fastify.authorize("orders.report.view");

  app.post(
    "/:id/qc-decision",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["QC"],
        summary: "Submit a QC decision",
        description: "Only legal when the order is checked in at a station with `isQcCheckpoint: true` (409 otherwise) — in practice this is always the fixed QC system stage, which every order reaches only after clearing all its dynamic stations. APPROVED advances it like a normal outgoing scan would (on to the fixed Courier/Pick-up stage). REWORK requires `targetStationId` — any active dynamic (non-system) station qualifies, not a fixed pair; the target visit gets a new StationVisit row with `isReworkVisit: true`, leaving the original visit's timestamps untouched. Optionally pass `orderItemIds` to flag exactly which item(s) on the order had the defect.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: qcDecisionBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const order = await submitQcDecision(fastify.prisma, request.params.id, request.user.sub, request.body);
      return toOrderDto(order);
    },
  );

  app.get(
    "/:id/qc-reviews",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["QC"],
        summary: "QC review history for an order",
        description: "Every QC decision ever recorded for this order, newest first — outcome, notes, reviewer, the checkpoint station, and (for REWORK) the associated rework detail (target station, reason, rejection-reason category). Same access tier as GET /orders/:id/timeline.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: qcReviewListResponseSchema },
      },
    },
    async (request) => listQcReviewsForOrder(fastify.prisma, request.params.id),
  );

  app.get(
    "/reports/qc",
    {
      preHandler: [fastify.authenticate, reportView],
      schema: {
        tags: ["QC"],
        summary: "QC pass/rework metrics report",
        description: "Aggregate QC metrics across all orders in the given date range (filtered on when the QC decision was recorded): total reviews, approve/rework counts, rework rate, and rework counts broken down by which station the rework was routed to (i.e. whose work needed redoing) and by rejection-reason category.",
        security: [{ bearerAuth: [] }],
        querystring: qcReportQuerySchema,
        response: { 200: qcReportResponseSchema },
      },
    },
    async (request) => getQcReport(fastify.prisma, request.query),
  );
}
