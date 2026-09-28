import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { assertAdminAccessRetained } from "../../lib/adminGuard";
import { recordActivity } from "../../lib/activityLog";
import { slugify } from "../../lib/slugify";

const ROLE_INCLUDE = {
  permissions: { include: { permission: { select: { id: true, slug: true, name: true } } } },
} satisfies Prisma.RoleInclude;

type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

function toRoleDto(role: RoleWithPermissions) {
  const { permissions, ...rest } = role;
  return { ...rest, permissions: permissions.map((p) => p.permission) };
}

export async function listRoles(prisma: PrismaClient) {
  const roles = await prisma.role.findMany({ include: ROLE_INCLUDE, orderBy: { name: "asc" } });
  return roles.map(toRoleDto);
}

export async function getRoleOrThrow(prisma: PrismaClient, id: string) {
  const role = await prisma.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
  if (!role) throw new NotFoundError("Role not found");
  return toRoleDto(role);
}

async function assertValidPermissionSlugs(prisma: PrismaClient, slugs: string[]) {
  if (slugs.length === 0) return;
  const found = await prisma.permission.findMany({ where: { slug: { in: slugs } }, select: { slug: true } });
  const foundSlugs = new Set(found.map((p) => p.slug));
  const unknown = slugs.filter((s) => !foundSlugs.has(s));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown permission slug(s): ${unknown.join(", ")}`);
  }
}

export interface CreateRoleInput {
  name: string;
  slug?: string;
  description?: string;
  permissionSlugs: string[];
}

export async function createRole(prisma: PrismaClient, actorUserId: string, input: CreateRoleInput) {
  const slug = input.slug ?? slugify(input.name);

  const existing = await prisma.role.findFirst({ where: { OR: [{ name: input.name }, { slug }] } });
  if (existing) {
    throw new ValidationError("A role with this name or slug already exists");
  }
  await assertValidPermissionSlugs(prisma, input.permissionSlugs);

  const permissions = await prisma.permission.findMany({ where: { slug: { in: input.permissionSlugs } } });

  const created = await prisma.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
      },
    });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "ROLE",
      entityId: role.id,
      actorUserId,
      message: `Role ${role.name} created.`,
    });

    return role;
  });

  return getRoleOrThrow(prisma, created.id);
}

export interface UpdateRoleInput {
  name?: string;
  slug?: string;
  description?: string | null;
  isActive?: boolean;
  permissionSlugs?: string[];
}

export async function updateRole(prisma: PrismaClient, id: string, actorUserId: string, input: UpdateRoleInput) {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role not found");

  if (input.name || input.slug) {
    const conflict = await prisma.role.findFirst({
      where: {
        id: { not: id },
        OR: [input.name ? { name: input.name } : undefined, input.slug ? { slug: input.slug } : undefined].filter(
          Boolean,
        ) as object[],
      },
    });
    if (conflict) throw new ValidationError("A role with this name or slug already exists");
  }

  if (input.permissionSlugs) {
    await assertValidPermissionSlugs(prisma, input.permissionSlugs);
  }

  await prisma.$transaction(async (tx) => {
    await tx.role.update({
      where: { id },
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        isActive: input.isActive,
      },
    });

    if (input.permissionSlugs) {
      const permissions = await tx.permission.findMany({ where: { slug: { in: input.permissionSlugs } } });
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
        });
      }
    }

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "ROLE",
      entityId: id,
      actorUserId,
      message: `Role updated.`,
    });

    if (input.isActive !== undefined || input.permissionSlugs !== undefined) {
      await assertAdminAccessRetained(tx);
    }
  });

  return getRoleOrThrow(prisma, id);
}
