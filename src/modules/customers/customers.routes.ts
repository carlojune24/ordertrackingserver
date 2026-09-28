import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createCustomerBodySchema,
  customerIdParamsSchema,
  customerListResponseSchema,
  customerOrdersQuerySchema,
  customerResponseSchema,
  listCustomersQuerySchema,
  updateCustomerBodySchema,
} from "./customers.schemas";
import {
  archiveCustomer,
  createCustomer,
  getCustomerDetail,
  getCustomerOrThrow,
  listCustomers,
  unarchiveCustomer,
  updateCustomer,
} from "./customers.service";
import { orderListResponseSchema } from "../orders/orders.schemas";
import { listOrders, toOrderDto } from "../orders/orders.service";

export default async function customersRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const customersCreate = fastify.authorize("orders.create");
  const customersEdit = fastify.authorize("orders.edit");
  const customersArchive = fastify.authorize("orders.archive");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Customers"],
        summary: "List / search customers",
        description: "Any authenticated role can read this — it's used to look up a customer at intake as much as it is a management screen. `search` matches name, phone, or email, case-insensitive. Archived customers are excluded by default.",
        security: [{ bearerAuth: [] }],
        querystring: listCustomersQuerySchema,
        response: { 200: customerListResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize, ...rest } = request.query;
      const { items, total } = await listCustomers(fastify.prisma, { page, pageSize, ...rest });
      return { items, page, pageSize, total };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Customers"],
        summary: "Get a customer",
        description: "Includes orderCount — total orders ever placed by this customer. Returns even if archived.",
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: customerResponseSchema },
      },
    },
    async (request) => getCustomerDetail(fastify.prisma, request.params.id),
  );

  app.get(
    "/:id/orders",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Customers"],
        summary: "A customer's full order history",
        description: "Every order this customer has placed — this is how 'how many times has this customer ordered' is answered in full (alongside orderCount on GET /customers/:id for the quick total). Same sort as the main dashboard (priority, then deadline), same filters available (status, includeArchived, archivedOnly), just pre-scoped to this customer. 404s if the customer doesn't exist.",
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        querystring: customerOrdersQuerySchema,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => {
      await getCustomerOrThrow(fastify.prisma, request.params.id);
      const { page, pageSize, ...rest } = request.query;
      const { items, total } = await listOrders(fastify.prisma, {
        customerId: request.params.id,
        page,
        pageSize,
        ...rest,
      });
      return { items: items.map(toOrderDto), page, pageSize, total };
    },
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, customersCreate],
      schema: {
        tags: ["Customers"],
        summary: "Create a customer",
        description: "A customer must exist here before they can be selected at order intake — there's no free-text customer entry anywhere else in this API. `email`, if given, must be unique across all customers.",
        security: [{ bearerAuth: [] }],
        body: createCustomerBodySchema,
        response: { 201: customerResponseSchema },
      },
    },
    async (request, reply) => {
      const customer = await createCustomer(fastify.prisma, request.body);
      reply.code(201);
      return customer;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, customersEdit],
      schema: {
        tags: ["Customers"],
        summary: "Edit a customer",
        description: "Partial update. Rejected with 409 if the customer is archived — unarchive first.",
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        body: updateCustomerBodySchema,
        response: { 200: customerResponseSchema },
      },
    },
    async (request) => updateCustomer(fastify.prisma, request.params.id, request.body),
  );

  app.post(
    "/:id/archive",
    {
      preHandler: [fastify.authenticate, customersArchive],
      schema: {
        tags: ["Customers"],
        summary: "Archive a customer",
        description: "Freezes the customer (further edits rejected with 409) and hides it from GET /customers by default. They can no longer be selected for a new order, or repointed onto an existing one, until unarchived. Idempotent.",
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: customerResponseSchema },
      },
    },
    async (request) => archiveCustomer(fastify.prisma, request.params.id),
  );

  app.post(
    "/:id/unarchive",
    {
      preHandler: [fastify.authenticate, customersArchive],
      schema: {
        tags: ["Customers"],
        summary: "Unarchive a customer",
        description: "Reverses archive — editable again and reappears in the default GET /customers listing, and can be selected for orders again. Idempotent.",
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: customerResponseSchema },
      },
    },
    async (request) => unarchiveCustomer(fastify.prisma, request.params.id),
  );
}
