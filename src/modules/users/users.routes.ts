import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createUserBodySchema,
  listUsersQuerySchema,
  updateUserBodySchema,
  userIdParamsSchema,
  userListResponseSchema,
  userResponseSchema,
} from "./users.schemas";
import { createUser, listUsers, updateUser } from "./users.service";
import { orderListResponseSchema, listOrdersQuerySchema } from "../orders/orders.schemas";
import { listCompletedOrdersForUser, toOrderDto } from "../orders/orders.service";
import { qcReviewsForUserListResponseSchema, qcReviewsForUserQuerySchema } from "../qc/qc.schemas";
import { listQcReviewsForUser } from "../qc/qc.service";
import { employeeTasksQuerySchema, employeeTasksResponseSchema } from "../stations/stations.schemas";
import { getEmployeeTasks } from "../stations/stations.service";

export default async function usersRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const usersManage = fastify.authorize("users.manage");
  const completedOrdersQuerySchema = listOrdersQuerySchema.pick({ page: true, pageSize: true });

  app.get(
    "/",
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          try {
            await fastify.authorize("users.manage")(request, reply);
          } catch {
            // Also usable by report viewers (e.g. Supervisor) to search up an employee before
            // pulling their performance report — they don't get account-management actions,
            // just this read.
            await fastify.authorize("orders.report.view")(request, reply);
          }
        },
      ],
      schema: {
        tags: ["Users"],
        summary: "List users",
        description: "Every account, oldest first. Includes disabled (`isActive: false`) accounts — filter client-side if you only want active ones. Optionally filter to a single station's assigned workers, or search by name/email.",
        security: [{ bearerAuth: [] }],
        querystring: listUsersQuerySchema,
        response: { 200: userListResponseSchema },
      },
    },
    async (request) => listUsers(fastify.prisma, request.query),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, usersManage],
      schema: {
        tags: ["Users"],
        summary: "Create a user",
        description: "Fails with 400 if the email is already taken, or if `roleId` doesn't reference an active role. There's no email verification flow — the account is active and can log in immediately.",
        security: [{ bearerAuth: [] }],
        body: createUserBodySchema,
        response: { 201: userResponseSchema },
      },
    },
    async (request, reply) => {
      const user = await createUser(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return user;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, usersManage],
      schema: {
        tags: ["Users"],
        summary: "Update a user",
        description: "Partial update — send only the fields you're changing. There is no delete endpoint; set `isActive: false` to revoke a login instead of removing the account (preserves the audit trail of everything they did). Deactivating or reassigning the last user able to manage users/roles is blocked with 409.",
        security: [{ bearerAuth: [] }],
        params: userIdParamsSchema,
        body: updateUserBodySchema,
        response: { 200: userResponseSchema },
      },
    },
    async (request) => updateUser(fastify.prisma, request.params.id, request.user.sub, request.body),
  );

  app.get(
    "/:id/completed-orders",
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (request.user.sub === request.params.id) return;
          await fastify.authorize("orders.report.view")(request, reply);
        },
      ],
      schema: {
        tags: ["Users"],
        summary: "A user's completed (delivered) orders",
        description: "Orders where this user physically scanned a receive or outgoing at any StationVisit, at any station, and the order has since reached DELIVERED. Not createdByUserId, not QC/delivery actor, not station assignment. Excludes archived orders. Callers may view their own history, or anyone's with orders.report.view.",
        security: [{ bearerAuth: [] }],
        params: userIdParamsSchema,
        querystring: completedOrdersQuerySchema,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize } = request.query;
      const { items, total } = await listCompletedOrdersForUser(fastify.prisma, request.params.id, { page, pageSize });
      return { items: items.map(toOrderDto), page, pageSize, total };
    },
  );

  app.get(
    "/:id/qc-reviews",
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (request.user.sub === request.params.id) return;
          await fastify.authorize("orders.report.view")(request, reply);
        },
      ],
      schema: {
        tags: ["Users"],
        summary: "A user's QC review history",
        description: "Every formal QC decision this user has personally recorded as reviewer, newest first — outcome, which order, which checkpoint station, and (for REWORK) the associated rework detail (target station, reason, rejection-reason category). The 'which orders did I flag, and why' view. Does not include a regular station's own rejection via POST /scan/reject, which never creates a QcReview. Callers may view their own history, or anyone's with orders.report.view.",
        security: [{ bearerAuth: [] }],
        params: userIdParamsSchema,
        querystring: qcReviewsForUserQuerySchema,
        response: { 200: qcReviewsForUserListResponseSchema },
      },
    },
    async (request) => listQcReviewsForUser(fastify.prisma, request.params.id, request.query),
  );

  app.get(
    "/:id/performance",
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (request.user.sub === request.params.id) return;
          await fastify.authorize("orders.report.view")(request, reply);
        },
      ],
      schema: {
        tags: ["Users"],
        summary: "Employee performance report",
        description: "This employee's task history across every station they've ever been received at — not just their current assignedStationId — bucketed into IN_PROGRESS (checked in, not yet sent onward), REWORK (a redo routed here by a regular station's own rejection), QC_FLAG (a redo routed here by a formal QC decision), and COMPLETED (sent onward, and not a redo). `counts` covers their whole history regardless of the `category` filter/pagination. Callers may view their own report, or anyone's with orders.report.view.",
        security: [{ bearerAuth: [] }],
        params: userIdParamsSchema,
        querystring: employeeTasksQuerySchema,
        response: { 200: employeeTasksResponseSchema },
      },
    },
    async (request) => getEmployeeTasks(fastify.prisma, request.params.id, request.query),
  );
}
