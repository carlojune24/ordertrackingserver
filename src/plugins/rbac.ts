import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError } from "../lib/errors";

declare module "fastify" {
  interface FastifyInstance {
    authorize: (permissionSlug: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate("authorize", (permissionSlug: string) => {
    return async (request: FastifyRequest) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.user.sub },
        select: {
          isActive: true,
          role: {
            select: {
              isActive: true,
              permissions: { where: { permission: { slug: permissionSlug } }, take: 1 },
            },
          },
        },
      });

      if (!user?.isActive || !user.role?.isActive || user.role.permissions.length === 0) {
        throw new ForbiddenError("You do not have permission to perform this action");
      }
    };
  });
});
