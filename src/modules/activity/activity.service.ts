import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { ActivityLogAction, ActivityLogEntityType } from "../../generated/prisma/enums";

export interface ListActivityFilter {
  actorUserId?: string;
  action?: ActivityLogAction;
  entityType?: ActivityLogEntityType;
  entityId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export async function listActivity(prisma: PrismaClient, filter: ListActivityFilter) {
  const where: Prisma.ActivityLogWhereInput = {};
  if (filter.actorUserId) where.actorUserId = filter.actorUserId;
  if (filter.action) where.action = filter.action;
  if (filter.entityType) where.entityType = filter.entityType;
  if (filter.entityId) where.entityId = filter.entityId;
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  const [items, total] = await prisma.$transaction([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.activityLog.count({ where }),
  ]);

  const actorIds = [...new Set(items.map((i) => i.actorUserId).filter((id): id is string => id !== null))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, roleName: a.role.name }]));

  return {
    items: items.map((item) => ({
      ...item,
      actor: item.actorUserId
        ? (actorById.get(item.actorUserId) ?? { id: item.actorUserId, name: "Unknown", roleName: null })
        : null,
    })),
    total,
  };
}
