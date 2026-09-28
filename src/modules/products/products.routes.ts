import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  addColorLiningBodySchema,
  addProductImageBodySchema,
  createProductBodySchema,
  listProductsQuerySchema,
  priceHistoryResponseSchema,
  productColorLiningIdParamsSchema,
  productIdParamsSchema,
  productImageIdParamsSchema,
  productListResponseSchema,
  productResponseSchema,
  updateColorLiningBodySchema,
  updateProductBodySchema,
} from "./products.schemas";
import {
  addColorLining,
  addProductImage,
  createProduct,
  getProductOrThrow,
  getProductPriceHistory,
  listProducts,
  removeProductImage,
  updateColorLining,
  updateProduct,
  uploadProductImage,
} from "./products.service";
import { ValidationError } from "../../lib/errors";

export default async function productsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const managementOnly = fastify.authorize("products.manage");
  const priceHistoryView = fastify.authorize("products.price_history.view");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Products"],
        summary: "List products",
        description: "Active only by default, with images and color linings nested on each item so a catalog picker can render thumbnails and variant options from a single request.",
        security: [{ bearerAuth: [] }],
        querystring: listProductsQuerySchema,
        response: { 200: productListResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize, ...rest } = request.query;
      const { items, total } = await listProducts(fastify.prisma, { page, pageSize, ...rest });
      return { items, page, pageSize, total };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Products"],
        summary: "Get a product",
        description: "404 if the product doesn't exist — note this returns retired (`isActive: false`) products too, unlike the list endpoint's default.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        response: { 200: productResponseSchema },
      },
    },
    async (request) => getProductOrThrow(fastify.prisma, request.params.id),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Create a product",
        description: "`images` and `colorLinings` can be supplied inline at creation, or added later via their own endpoints below. Writes the first `ProductPriceHistory` row automatically.",
        security: [{ bearerAuth: [] }],
        body: createProductBodySchema,
        response: { 201: productResponseSchema },
      },
    },
    async (request, reply) => {
      const product = await createProduct(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return product;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Update a product",
        description: "Partial update. If `regularPrice` and/or `customizedPrice` actually change value, a new `ProductPriceHistory` row is written automatically — other field changes (name, description, `isActive`, ...) never add one. This never touches prices already snapshotted on existing orders.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        body: updateProductBodySchema,
        response: { 200: productResponseSchema },
      },
    },
    async (request) => updateProduct(fastify.prisma, request.params.id, request.user.sub, request.body),
  );

  app.get(
    "/:id/price-history",
    {
      preHandler: [fastify.authenticate, priceHistoryView],
      schema: {
        tags: ["Products"],
        summary: "Price change history",
        description: "Every recorded regularPrice/customizedPrice change for this product, newest first, with who made each change. This is about the *product's* price over time — see the OrderItem's `unitPrice`/`regularPriceAtOrder` fields for what a specific order item actually paid, which is frozen when the item was added and unaffected by later product price changes.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        response: { 200: priceHistoryResponseSchema },
      },
    },
    async (request) => getProductPriceHistory(fastify.prisma, request.params.id),
  );

  app.post(
    "/:id/images",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Add a product image",
        description: "`url` must point to an already-hosted image — there's no file upload endpoint, so host it elsewhere first (e.g. an existing CDN/bucket) and pass the link.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        body: addProductImageBodySchema,
        response: { 201: productResponseSchema },
      },
    },
    async (request, reply) => {
      const product = await addProductImage(fastify.prisma, request.params.id, request.body);
      reply.code(201);
      return product;
    },
  );

  app.post(
    "/:id/images/upload",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Upload a product image",
        description: "Multipart file upload (field name `file`) — stored locally on the server under /uploads/products and served back as a public URL, no third-party storage involved. Accepts JPEG, PNG, GIF, or WebP, validated by the file's actual content rather than its extension, up to 5MB. Prefer this over POST /:id/images when you don't already have the photo hosted somewhere.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        consumes: ["multipart/form-data"],
        response: { 201: productResponseSchema },
      },
    },
    async (request, reply) => {
      const file = await request.file().catch(() => undefined);
      if (!file) {
        throw new ValidationError('No file uploaded — send multipart/form-data with a field named "file".');
      }
      const buffer = await file.toBuffer();
      const product = await uploadProductImage(fastify.prisma, request.params.id, buffer);
      reply.code(201);
      return product;
    },
  );

  app.delete(
    "/:id/images/:imageId",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Remove a product image",
        description: "A real (hard) delete, unlike most of this API — safe here because no Order ever references a specific image, so nothing historical depends on it.",
        security: [{ bearerAuth: [] }],
        params: productImageIdParamsSchema,
        response: { 200: productResponseSchema },
      },
    },
    async (request) => removeProductImage(fastify.prisma, request.params.id, request.params.imageId),
  );

  app.post(
    "/:id/color-linings",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Add a color lining option",
        description: "Options are scoped to this one product, not a shared global list — different products can offer entirely different lining choices. Fails with 400 if this product already has a lining with the same `label`.",
        security: [{ bearerAuth: [] }],
        params: productIdParamsSchema,
        body: addColorLiningBodySchema,
        response: { 201: productResponseSchema },
      },
    },
    async (request, reply) => {
      const product = await addColorLining(fastify.prisma, request.params.id, request.body);
      reply.code(201);
      return product;
    },
  );

  app.patch(
    "/:id/color-linings/:liningId",
    {
      preHandler: [fastify.authenticate, managementOnly],
      schema: {
        tags: ["Products"],
        summary: "Update a color lining option",
        description: "No delete — set `isActive: false` to retire an option instead, since an existing OrderItem may reference it (`OrderItem.colorLiningId`) and that reference must never dangle.",
        security: [{ bearerAuth: [] }],
        params: productColorLiningIdParamsSchema,
        body: updateColorLiningBodySchema,
        response: { 200: productResponseSchema },
      },
    },
    async (request) =>
      updateColorLining(fastify.prisma, request.params.id, request.params.liningId, request.body),
  );
}
