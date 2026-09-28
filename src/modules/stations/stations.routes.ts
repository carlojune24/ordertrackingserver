import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createStationBodySchema,
  listStationsQuerySchema,
  stationCurrentOrdersQuerySchema,
  stationIdParamsSchema,
  stationListResponseSchema,
  stationQueueResponseSchema,
  stationResponseSchema,
  stationThroughputReportQuerySchema,
  stationThroughputReportResponseSchema,
  updateStationBodySchema,
} from "./stations.schemas";
import {
  createStation,
  getStationOrThrow,
  getStationQueue,
  getStationThroughputReport,
  listStations,
  updateStation,
} from "./stations.service";
import { orderListResponseSchema } from "../orders/orders.schemas";
import { listOrders, toOrderDto } from "../orders/orders.service";

export default async function stationsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const managementOnly = fastify.authorize("stations.manage");
  const reportView = fastify.authorize("orders.report.view");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Stations"],
        summary: "List stations",
        description: "Sorted by `sortOrder`, with fixed system stages (QC, Packaging, Courier/Pick-up — `isSystem: true`) always last, in that order — this list *is* the production sequence orders flow through. Active only by default.",
        security: [{ bearerAuth: [] }],
        querystring: listStationsQuerySchema,
        response: { 200: stationListResponseSchema },
      },
    },
    async (request) => listStations(fastify.prisma, request.query.includeInactive),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Stations"],
        summary: "Create a station",
        description: "Adding a new station is always safe, even mid-flight — unlike changing an existing station's sortOrder, it doesn't reshuffle where any in-progress order is expected next.",
        security: [{ bearerAuth: [] }],
        body: createStationBodySchema,
        response: { 201: stationResponseSchema },
      },
    },
    async (request, reply) => {
      const station = await createStation(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return station;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Stations"],
        summary: "Update a station",
        description: "Changing `sortOrder` — an actual reorder, not just resubmitting the current value — is rejected with 409 while any order is `IN_PROGRESS`, since the production sequence is computed live and reordering mid-flight could silently skip a station an order hasn't reached yet. Every other field (name, logo, color, `isQcCheckpoint`, `isActive`) can be changed anytime. No delete — retire with `isActive: false`. System stages (QC, Packaging, Courier/Pick-up — `isSystem: true`) reject every edit outright, always with 409.",
        security: [{ bearerAuth: [] }],
        params: stationIdParamsSchema,
        body: updateStationBodySchema,
        response: { 200: stationResponseSchema },
      },
    },
    async (request) => updateStation(fastify.prisma, request.params.id, request.user.sub, request.body),
  );

  app.get(
    "/:id/current-orders",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Stations"],
        summary: "Orders currently received at a station",
        description: "Orders whose currentStationId is this station AND isCheckedIn is true — physically standing here right now, not just in transit toward it. 404s if the station doesn't exist.",
        security: [{ bearerAuth: [] }],
        params: stationIdParamsSchema,
        querystring: stationCurrentOrdersQuerySchema,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => {
      await getStationOrThrow(fastify.prisma, request.params.id);
      const { page, pageSize } = request.query;
      const { items, total } = await listOrders(fastify.prisma, {
        stationId: request.params.id,
        isCheckedIn: true,
        page,
        pageSize,
      });
      return { items: items.map(toOrderDto), page, pageSize, total };
    },
  );

  app.get(
    "/:id/queue",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Stations"],
        summary: "Full working queue for a station",
        description: "Every order currently at this station — pending (in transit toward it), or physically checked in — each annotated with why it's here (NEW/FORWARD/REWORK/QC_REROUTE/RETURNED, who it came from, the rejection reason if any) and a proper 'since' timestamp, plus bucketed counts (pending/inProgress/rework/qcFlag). Built for a floor-facing station queue screen, so you don't have to reconstruct arrival context from each order's own timeline. 404s if the station doesn't exist.",
        security: [{ bearerAuth: [] }],
        params: stationIdParamsSchema,
        response: { 200: stationQueueResponseSchema },
      },
    },
    async (request) => getStationQueue(fastify.prisma, request.params.id),
  );

  app.get(
    "/reports/throughput",
    {
      preHandler: [fastify.authenticate, reportView],
      schema: {
        tags: ["Stations"],
        summary: "Station throughput / bottleneck report",
        description: "Aggregate dwell-time and volume metrics per station across all orders in the given date range (filtered on when each visit was received): total/completed/open visit counts, rework-visit ratio, and average + median time spent at the station. Sorted slowest-first so the actual bottleneck across the whole shop floor is immediately visible — unlike GET /orders/:id/report, which only covers one order's own visits. Median is included alongside average since one unusually slow outlier visit can otherwise skew the average without reflecting the typical case.",
        security: [{ bearerAuth: [] }],
        querystring: stationThroughputReportQuerySchema,
        response: { 200: stationThroughputReportResponseSchema },
      },
    },
    async (request) => getStationThroughputReport(fastify.prisma, request.query),
  );
}
