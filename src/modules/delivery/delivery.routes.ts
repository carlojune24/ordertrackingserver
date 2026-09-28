import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { deliveredReportQuerySchema, deliveredReportResponseSchema, deliveryOutcomeBodySchema } from "./delivery.schemas";
import { getDeliveredReport, recordDeliveryOutcome } from "./delivery.service";
import { orderIdParamsSchema, orderResponseSchema } from "../orders/orders.schemas";
import { toOrderDto } from "../orders/orders.service";

export default async function deliveryRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const staffPlus = fastify.authorize("delivery.record");
  const reportView = fastify.authorize("orders.report.view");

  app.post(
    "/:id/delivery-outcome",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["Delivery"],
        summary: "Record a delivery outcome",
        description: "Only legal once outgoing has actually been scanned at the fixed Courier/Pick-up system stage for this pass — the last step in every order's sequence, reached only after QC approval and a Packaging pass. Being merely *expected* at Courier (e.g. right after Packaging's outgoing scan, before it's physically scanned) still 409s, and so does a stale closed visit left over from before a RETURNED outcome — a real receive+outgoing punch for the current pass is required every time. DELIVERED sets `status: DELIVERED` and clears `currentStationId`; optionally pass `courierName`/`waybillNumber` when the delivery went out via a third-party courier (e.g. J&T Express) rather than an in-person pickup/hand-off. RETURNED (with a required `returnReason`) always routes the order to the fixed Return station, where staff receive it with a normal scan and then decide via POST /orders/:id/return-decision: send it to QC, or flag items for replacement. The order stays IN_PROGRESS on the same order number and timeline.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: deliveryOutcomeBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const order = await recordDeliveryOutcome(fastify.prisma, request.params.id, request.user.sub, request.body);
      return toOrderDto(order);
    },
  );

  app.get(
    "/reports/delivered",
    {
      preHandler: [fastify.authenticate, reportView],
      schema: {
        tags: ["Delivery"],
        summary: "Delivered orders log",
        description: "Newest-first log of every DELIVERED outcome in the given date range (filtered on when the delivery was recorded), with courier/waybill detail and the delivered item lines inlined — unlike GET /orders?status=DELIVERED, which neither includes DeliveryOutcome detail nor sorts by delivery time. Built for a delivery-station history screen: what went out, via which courier, when. Pass `courierName` to filter to one courier (case-insensitive partial match); omit it to include every delivery, courier-fulfilled or in-person pickup/hand-off alike. RETURNED outcomes never appear here.",
        security: [{ bearerAuth: [] }],
        querystring: deliveredReportQuerySchema,
        response: { 200: deliveredReportResponseSchema },
      },
    },
    async (request) => getDeliveredReport(fastify.prisma, request.query),
  );
}
