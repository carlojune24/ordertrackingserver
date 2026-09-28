import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createPromoCodeBodySchema,
  listPromoCodesQuerySchema,
  promoCodeIdParamsSchema,
  promoCodeListResponseSchema,
  promoCodeResponseSchema,
  updatePromoCodeBodySchema,
} from "./promoCodes.schemas";
import { createPromoCode, listPromoCodes, updatePromoCode } from "./promoCodes.service";

export default async function promoCodesRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const managementOnly = fastify.authorize("promos.manage");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Promo Codes"],
        summary: "List promo codes",
        description: "Newest first, active only by default. Includes usesCount so redemptions can be tracked against maxUses.",
        security: [{ bearerAuth: [] }],
        querystring: listPromoCodesQuerySchema,
        response: { 200: promoCodeListResponseSchema },
      },
    },
    async (request) => listPromoCodes(fastify.prisma, request.query.includeInactive),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Promo Codes"],
        summary: "Create a promo code",
        description: "Staff apply a code at intake via `promoCode` on POST /orders. Fails with 400 if the code already exists.",
        security: [{ bearerAuth: [] }],
        body: createPromoCodeBodySchema,
        response: { 201: promoCodeResponseSchema },
      },
    },
    async (request, reply) => {
      const promo = await createPromoCode(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return promo;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Promo Codes"],
        summary: "Update a promo code",
        description: "Partial update; `code` itself cannot change. There is no delete — set `isActive: false` to retire it. Edits never change orders that already used the code (their discount is snapshotted).",
        security: [{ bearerAuth: [] }],
        params: promoCodeIdParamsSchema,
        body: updatePromoCodeBodySchema,
        response: { 200: promoCodeResponseSchema },
      },
    },
    async (request) => updatePromoCode(fastify.prisma, request.params.id, request.user.sub, request.body),
  );
}
