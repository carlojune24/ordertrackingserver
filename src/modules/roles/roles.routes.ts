import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createRoleBodySchema,
  roleIdParamsSchema,
  roleListResponseSchema,
  roleResponseSchema,
  updateRoleBodySchema,
} from "./roles.schemas";
import { createRole, listRoles, updateRole } from "./roles.service";

export default async function rolesRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const rolesManage = fastify.authorize("roles.manage");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate, rolesManage],
      schema: {
        tags: ["Roles"],
        summary: "List roles",
        description: "Every role with its assigned permissions, including retired (`isActive: false`) ones.",
        security: [{ bearerAuth: [] }],
        response: { 200: roleListResponseSchema },
      },
    },
    async () => listRoles(fastify.prisma),
  );

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, rolesManage],
      schema: {
        tags: ["Roles"],
        summary: "Create a role",
        description: "`slug` is auto-derived from `name` if omitted. Every entry in `permissionSlugs` must exist in the catalog (GET /permissions) — unknown slugs are rejected with 400.",
        security: [{ bearerAuth: [] }],
        body: createRoleBodySchema,
        response: { 201: roleResponseSchema },
      },
    },
    async (request, reply) => {
      const role = await createRole(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return role;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, rolesManage],
      schema: {
        tags: ["Roles"],
        summary: "Update a role",
        description: "Partial update. If `permissionSlugs` is present it replaces the entire set, not a merge. No delete — retire with `isActive: false`. Both `isActive` and `permissionSlugs` changes are blocked with 409 if they'd leave no active user able to manage users/roles (see the Roles & Permissions concept guide).",
        security: [{ bearerAuth: [] }],
        params: roleIdParamsSchema,
        body: updateRoleBodySchema,
        response: { 200: roleResponseSchema },
      },
    },
    async (request) => updateRole(fastify.prisma, request.params.id, request.user.sub, request.body),
  );
}
