import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  categoryIdParamsSchema,
  categoryListResponseSchema,
  categoryResponseSchema,
  createCategoryBodySchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from "./categories.schemas";
import { createCategory, listCategories, updateCategory, uploadCategoryLogo } from "./categories.service";
import { ValidationError } from "../../lib/errors";

export default async function categoriesRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const managementOnly = fastify.authorize("categories.manage");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Categories"],
        summary: "List categories",
        description: "Sorted by `sortOrder` then name — active only by default. Any authenticated role can read this; it's used to populate the intake product picker as much as it is a Management config screen.",
        security: [{ bearerAuth: [] }],
        querystring: listCategoriesQuerySchema,
        response: { 200: categoryListResponseSchema },
      },
    },
    async (request) => listCategories(fastify.prisma, request.query.includeInactive),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Categories"],
        summary: "Create a category",
        description: "`slug` is auto-derived from `name` if omitted. Fails with 400 if either the name or the resulting slug is already taken.",
        security: [{ bearerAuth: [] }],
        body: createCategoryBodySchema,
        response: { 201: categoryResponseSchema },
      },
    },
    async (request, reply) => {
      const category = await createCategory(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return category;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Categories"],
        summary: "Update a category",
        description: "Partial update. There's no delete — set `isActive: false` to retire a category instead, since products may still reference it historically.",
        security: [{ bearerAuth: [] }],
        params: categoryIdParamsSchema,
        body: updateCategoryBodySchema,
        response: { 200: categoryResponseSchema },
      },
    },
    async (request) => updateCategory(fastify.prisma, request.params.id, request.user.sub, request.body),
  );

  app.post(
    "/:id/logo/upload",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Categories"],
        summary: "Upload a category logo",
        description: "Multipart file upload (field name `file`) — stored locally on the server under /uploads/categories and served back as a public URL, no third-party storage involved. Accepts JPEG, PNG, GIF, or WebP, validated by the file's actual content rather than its extension, up to 5MB. Replaces the category's current logoUrl — if that was itself a locally-uploaded file, the old one is deleted. Prefer this over PATCH with a logoUrl when you don't already have the image hosted somewhere.",
        security: [{ bearerAuth: [] }],
        params: categoryIdParamsSchema,
        consumes: ["multipart/form-data"],
        response: { 200: categoryResponseSchema },
      },
    },
    async (request) => {
      const file = await request.file().catch(() => undefined);
      if (!file) {
        throw new ValidationError('No file uploaded — send multipart/form-data with a field named "file".');
      }
      const buffer = await file.toBuffer();
      return uploadCategoryLogo(fastify.prisma, request.params.id, request.user.sub, buffer);
    },
  );
}
