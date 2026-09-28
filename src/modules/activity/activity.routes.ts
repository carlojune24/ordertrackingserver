import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { activityListResponseSchema, listActivityQuerySchema } from "./activity.schemas";
import { listActivity } from "./activity.service";

export default async function activityRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const activityView = fastify.authorize("activity.view");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate, activityView],
      schema: {
        tags: ["Activity"],
        summary: "List activity log entries",
        description: "Management-only audit trail — login/logout/refresh-theft auth events plus create/update actions on Users, Roles, Stations, Categories, and Products. Order-lifecycle actions (scan/QC/delivery) are not included here; see /orders/:id/timeline for those. Newest first, filterable by actor, action, entity, and date range.",
        security: [{ bearerAuth: [] }],
        querystring: listActivityQuerySchema,
        response: { 200: activityListResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize, ...rest } = request.query;
      const { items, total } = await listActivity(fastify.prisma, { page, pageSize, ...rest });
      return { items, page, pageSize, total };
    },
  );
}
