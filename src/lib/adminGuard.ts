import type { Prisma } from "../generated/prisma/client";
import { ConflictError } from "./errors";

/** Permissions that must never end up with zero active holders — losing both means nobody can recover the system. */
const ADMIN_SLUGS = [
  { slug: "users.manage", label: "manage users" },
  { slug: "roles.manage", label: "manage roles" },
] as const;

/**
 * Call inside the same transaction as an edit that could remove admin access (deactivating
 * a user, reassigning a user's role, or changing a role's isActive/permission set) — throws
 * and rolls the whole edit back if it would leave zero currently-active users, on a
 * currently-active role, holding users.manage or roles.manage. There is no superuser bypass
 * in this system; this guard is the only thing preventing an unrecoverable lockout.
 */
export async function assertAdminAccessRetained(tx: Prisma.TransactionClient) {
  for (const { slug, label } of ADMIN_SLUGS) {
    const count = await tx.user.count({
      where: {
        isActive: true,
        role: { isActive: true, permissions: { some: { permission: { slug } } } },
      },
    });
    if (count === 0) {
      throw new ConflictError(
        `This change would leave no active user able to ${label} — blocked to prevent locking everyone out.`,
      );
    }
  }
}
