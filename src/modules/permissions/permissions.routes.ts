import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { permissionListResponseSchema } from "./permissions.schemas";
import { listPermissions } from "./permissions.service";

export default async function permissionsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const rolesManage = fastify.authorize("roles.manage");

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate, rolesManage],
      schema: {
        tags: ["Permissions"],
        summary: "List permissions",
        description: "The fixed, code-defined permission catalog — each slug corresponds to a hardcoded authorization check at a specific route. Read-only; there's no way to create a new permission via the API, since one wouldn't be wired to anything. Use this to populate a role-editor's checkbox list.",
        security: [{ bearerAuth: [] }],
        response: { 200: permissionListResponseSchema },
      },
    },
    async () => listPermissions(fastify.prisma),
  );
}
