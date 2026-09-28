import type { PrismaClient } from "../../generated/prisma/client";

export function listPermissions(prisma: PrismaClient) {
  return prisma.permission.findMany({ orderBy: { slug: "asc" } });
}
