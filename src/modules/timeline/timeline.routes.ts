import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getOrderReport, getOrderTimeline, getSalesReport } from "./timeline.service";
import { orderIdParamsSchema } from "../orders/orders.schemas";
import { reportResponseSchema, salesReportQuerySchema, salesReportResponseSchema, timelineResponseSchema } from "./timeline.schemas";

export default async function timelineRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const supervisorPlus = fastify.authorize("orders.report.view");

  app.get(
    "/:id/timeline",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Timeline & Reports"],
        summary: "Order event timeline",
        description: "The full chronological event feed — intake, every receive/outgoing, QC decisions, rework routing, delivery/return, QR regeneration — oldest first, with who did each one. Backed by an append-only OrderEvent table written in the same transaction as every state change, so it can never drift from the order's actual StationVisit/QcReview/DeliveryOutcome records.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: timelineResponseSchema },
      },
    },
    async (request) => getOrderTimeline(fastify.prisma, request.params.id),
  );

  app.get(
    "/:id/report",
    {
      preHandler: [fastify.authenticate, supervisorPlus],
      schema: {
        tags: ["Timeline & Reports"],
        summary: "Turnaround report",
        description: "Per-station visit durations (`sequenceNo > 1` on a visit means it's a rework/return revisit — the original visit's row is left intact above it), every delivery outcome recorded, and total turnaround from `orderDate` to delivery (or to now, if still open).",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: reportResponseSchema },
      },
    },
    async (request) => getOrderReport(fastify.prisma, request.params.id),
  );

  app.get(
    "/reports/sales",
    {
      preHandler: [fastify.authenticate, supervisorPlus],
      schema: {
        tags: ["Timeline & Reports"],
        summary: "Sales report",
        description: "Accounting-ledger-style sales report over orderDate. Returns a periodic `buckets` summary (day/month totals, for trend charts) alongside a full transaction-level `entries` ledger — one row per order in range, oldest first, with customer and every item line (product, unitPrice, discountAmount), order-level subtotal/totalDiscount/finalPrice, and a running revenue balance. `orderCount` counts orders, not item rows, even though revenue sums across every item. Counts every order placed in range regardless of status (IN_PROGRESS or DELIVERED) — the sale happens at intake, when the price is snapshotted, not when production finishes. Archived orders are excluded by default; pass `includeArchived=true` to include them. `from`/`to` are both optional; omit either for an open-ended range.",
        security: [{ bearerAuth: [] }],
        querystring: salesReportQuerySchema,
        response: { 200: salesReportResponseSchema },
      },
    },
    async (request) => getSalesReport(fastify.prisma, request.query),
  );
}
