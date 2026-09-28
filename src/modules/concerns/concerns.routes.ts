import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  allConcernsQuerySchema,
  allConcernsResponseSchema,
  concernIdParamsSchema,
  concernListResponseSchema,
  concernResponseSchema,
  raiseConcernBodySchema,
  resolveConcernBodySchema,
} from "./concerns.schemas";
import { listAllConcerns, listConcerns, raiseConcern, resolveConcern } from "./concerns.service";
import { orderIdParamsSchema } from "../orders/orders.schemas";

export default async function concernsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const scanPerform = fastify.authorize("scan.perform");
  const ordersEdit = fastify.authorize("orders.edit");
  const reportView = fastify.authorize("orders.report.view");

  app.post(
    "/:id/concerns",
    {
      preHandler: [fastify.authenticate, scanPerform],
      schema: {
        tags: ["Concerns"],
        summary: "Raise a concern or clarification",
        description: "Only legal while the order is currently checked in at a station (409 otherwise, and 409 if the order is archived). stationId/stationVisitId are captured server-side from the order's current position — never client-supplied. A station worker gets 403 unless the order's current station is their assigned station. Purely informational — never blocks delivery or any other workflow action.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: raiseConcernBodySchema,
        response: { 201: concernResponseSchema },
      },
    },
    async (request, reply) => {
      const concern = await raiseConcern(fastify.prisma, request.params.id, request.user.sub, request.body);
      reply.code(201);
      return concern;
    },
  );

  app.get(
    "/:id/concerns",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Concerns"],
        summary: "List concerns/clarifications for an order",
        description: "Newest first. Every raise/resolve also appears in GET /orders/:id/timeline.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: concernListResponseSchema },
      },
    },
    async (request) => listConcerns(fastify.prisma, request.params.id),
  );

  app.get(
    "/concerns",
    {
      preHandler: [fastify.authenticate, reportView],
      schema: {
        tags: ["Concerns"],
        summary: "Concerns/clarifications across every order",
        description: "Newest first, paginated. Pass isResolved=false for a cross-order 'open concerns' panel. Same access tier as the QC/sales reports (orders.report.view) — for a single order's concerns, use GET /orders/:id/concerns instead, which any authenticated user can read.",
        security: [{ bearerAuth: [] }],
        querystring: allConcernsQuerySchema,
        response: { 200: allConcernsResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize } = request.query;
      const { items, total } = await listAllConcerns(fastify.prisma, request.query);
      return { items, page, pageSize, total };
    },
  );

  app.patch(
    "/:id/concerns/:concernId/resolve",
    {
      preHandler: [fastify.authenticate, ordersEdit],
      schema: {
        tags: ["Concerns"],
        summary: "Resolve a concern/clarification",
        description: "Idempotent — resolving an already-resolved concern is a no-op returning it as-is. 409 if the order is archived.",
        security: [{ bearerAuth: [] }],
        params: concernIdParamsSchema,
        body: resolveConcernBodySchema,
        response: { 200: concernResponseSchema },
      },
    },
    async (request) =>
      resolveConcern(fastify.prisma, request.params.id, request.params.concernId, request.user.sub, request.body),
  );
}
