import bcrypt from "bcrypt";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { assertAdminAccessRetained } from "../../lib/adminGuard";
import { recordActivity } from "../../lib/activityLog";

const SALT_ROUNDS = 12;

const USER_INCLUDE = {
  role: { select: { id: true, name: true, slug: true } },
  assignedStation: { select: { id: true, name: true, slug: true } },
} as const;

export interface ListUsersFilter {
  assignedStationId?: string;
  search?: string;
}

export function listUsers(prisma: PrismaClient, filter?: ListUsersFilter) {
  const where: Prisma.UserWhereInput = {};
  if (filter?.assignedStationId) where.assignedStationId = filter.assignedStationId;
  if (filter?.search) {
    where.OR = [
      { name: { contains: filter.search, mode: "insensitive" } },
      { email: { contains: filter.search, mode: "insensitive" } },
    ];
  }

  return prisma.user.findMany({
    where,
    orderBy: { createdAt: "asc" },
    include: USER_INCLUDE,
  });
}

async function assertActiveRole(prisma: PrismaClient, roleId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role || !role.isActive) {
    throw new ValidationError("roleId does not reference an active role");
  }
}

/** assignedStationId may only reference an active, non-system (dynamic production) station —
 * QC, Packaging, and Courier/Pick-up are fixed stages nobody is individually assigned to. */
async function assertAssignableStation(prisma: PrismaClient, stationId: string) {
  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station || !station.isActive) {
    throw new ValidationError("assignedStationId does not reference an active station");
  }
  if (station.isSystem) {
    throw new ValidationError(`${station.name} is a fixed system stage — workers cannot be assigned to it`);
  }
}

export async function createUser(
  prisma: PrismaClient,
  actorUserId: string,
  input: { email: string; name: string; password: string; roleId: string; assignedStationId?: string | null },
) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ValidationError("A user with this email already exists");
  }
  await assertActiveRole(prisma, input.roleId);
  if (input.assignedStationId) {
    await assertAssignableStation(prisma, input.assignedStationId);
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        roleId: input.roleId,
        assignedStationId: input.assignedStationId ?? null,
        passwordHash,
      },
      include: USER_INCLUDE,
    });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "USER",
      entityId: user.id,
      actorUserId,
      message: `User ${user.email} created.`,
    });

    return user;
  });
}

export async function updateUser(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  input: {
    name?: string;
    password?: string;
    roleId?: string;
    isActive?: boolean;
    assignedStationId?: string | null;
  },
) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("User not found");
  }
  if (input.roleId) {
    await assertActiveRole(prisma, input.roleId);
  }
  if (input.assignedStationId) {
    await assertAssignableStation(prisma, input.assignedStationId);
  }

  const data: {
    name?: string;
    passwordHash?: string;
    roleId?: string;
    isActive?: boolean;
    assignedStationId?: string | null;
  } = {
    name: input.name,
    roleId: input.roleId,
    isActive: input.isActive,
    assignedStationId: input.assignedStationId,
  };
  if (input.password) {
    data.passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id }, data, include: USER_INCLUDE });

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "USER",
      entityId: updated.id,
      actorUserId,
      message: `User ${updated.email} updated.`,
    });

    if (input.isActive !== undefined || input.roleId !== undefined) {
      await assertAdminAccessRetained(tx);
    }

    return updated;
  });
}
