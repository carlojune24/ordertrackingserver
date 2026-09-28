import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createQcRejectionReasonBodySchema,
  listQcRejectionReasonsQuerySchema,
  qcRejectionReasonIdParamsSchema,
  qcRejectionReasonListResponseSchema,
  qcRejectionReasonResponseSchema,
  updateQcRejectionReasonBodySchema,
} from "./qcRejectionReasons.schemas";
import { createQcRejectionReason, listQcRejectionReasons, updateQcRejectionReason } from "./qcRejectionReasons.service";

export default async function qcRejectionReasonsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const managementOnly = fastify.authorize("qc_rejection_reasons.manage");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["QC Rejection Reasons"],
        summary: "List QC rejection reasons",
        description: "Sorted by name, active only by default. Any authenticated role can read this — it's used to populate the qc-decision rejection-reason picker as much as it is a Management config screen.",
        security: [{ bearerAuth: [] }],
        querystring: listQcRejectionReasonsQuerySchema,
        response: { 200: qcRejectionReasonListResponseSchema },
      },
    },
    async (request) => listQcRejectionReasons(fastify.prisma, request.query.includeInactive),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["QC Rejection Reasons"],
        summary: "Create a QC rejection reason",
        description: "`slug` is auto-derived from `name` if omitted. Fails with 400 if either the name or the resulting slug is already taken.",
        security: [{ bearerAuth: [] }],
        body: createQcRejectionReasonBodySchema,
        response: { 201: qcRejectionReasonResponseSchema },
      },
    },
    async (request, reply) => {
      const reason = await createQcRejectionReason(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return reason;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["QC Rejection Reasons"],
        summary: "Update a QC rejection reason",
        description: "Partial update. There's no delete — set `isActive: false` to retire a reason instead, since past rework decisions may still reference it.",
        security: [{ bearerAuth: [] }],
        params: qcRejectionReasonIdParamsSchema,
        body: updateQcRejectionReasonBodySchema,
        response: { 200: qcRejectionReasonResponseSchema },
      },
    },
    async (request) => updateQcRejectionReason(fastify.prisma, request.params.id, request.user.sub, request.body),
  );
}
