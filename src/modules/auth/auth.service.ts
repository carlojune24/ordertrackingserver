import bcrypt from "bcrypt";
import crypto from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { UnauthorizedError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/** Short — the whole point of adding refresh tokens is to shrink a leaked access token's
 * blast radius. Sessions stay seamless via silent refresh, not a long-lived access JWT. */
export const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;

const ROLE_WITH_PERMISSIONS_INCLUDE = {
  role: { include: { permissions: { select: { permission: { select: { slug: true } } } } } },
  assignedStation: { select: { id: true, name: true } },
} as const;

/** Refresh tokens are high-entropy random data, not human passwords — sha256 (not bcrypt)
 * is the right tool here, same reasoning as hashing an API key rather than a password. */
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateOpaqueToken(): string {
  return crypto.randomBytes(40).toString("hex");
}

function toPermissionSlugs(user: { role: { permissions: { permission: { slug: string } }[] } }): string[] {
  return user.role.permissions.map((rp) => rp.permission.slug);
}

export async function verifyLogin(prisma: PrismaClient, email: string, password: string, context: RequestContext = {}) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: ROLE_WITH_PERMISSIONS_INCLUDE,
  });
  if (!user || !user.isActive || !user.role.isActive) {
    await recordActivity(prisma, {
      action: "LOGIN_FAILURE",
      actorUserId: null,
      actorEmail: email,
      ip: context.ip,
      userAgent: context.userAgent,
      message: "Login failed: unknown or inactive account/role.",
    });
    throw new UnauthorizedError("Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await recordActivity(prisma, {
      action: "LOGIN_FAILURE",
      actorUserId: user.id,
      actorEmail: email,
      ip: context.ip,
      userAgent: context.userAgent,
      message: "Login failed: incorrect password.",
    });
    throw new UnauthorizedError("Invalid email or password");
  }

  await recordActivity(prisma, {
    action: "LOGIN_SUCCESS",
    actorUserId: user.id,
    actorEmail: email,
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return user;
}

/** Issues a brand-new refresh token (a fresh family) — call at login only. Every later
 * rotation of this token stays in the same family via rotateRefreshToken. */
export async function issueRefreshToken(prisma: PrismaClient, userId: string): Promise<string> {
  const raw = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      familyId: crypto.randomUUID(),
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return raw;
}

/**
 * Redeems a refresh token for a new access token + a new, rotated refresh token. Always
 * revokes the token it was given, whether or not the exchange succeeds:
 * - Unknown token: 401, nothing to revoke.
 * - Already-revoked token being presented again is treated as theft (a legitimate client
 *   only ever holds the newest token in its family) — the entire family is revoked so every
 *   token descended from that login stops working, forcing a fresh login.
 * - Expired token: 401, left revoked (rotation would have revoked it anyway had it not
 *   already expired, so this doesn't skip anything a valid exchange would have done).
 * - Deactivated user/role: 401 — never keep an already-deactivated account's session alive
 *   for the days-long refresh-token window.
 */
export async function rotateRefreshToken(prisma: PrismaClient, rawToken: string, context: RequestContext = {}) {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!record) {
    throw new UnauthorizedError("Invalid refresh token");
  }

  if (record.revokedAt) {
    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.activityLog.create({
        data: {
          action: "REFRESH_TOKEN_REUSE_DETECTED",
          actorUserId: record.userId,
          ip: context.ip,
          userAgent: context.userAgent,
          message: "Refresh token reuse detected — entire token family revoked.",
        },
      }),
    ]);
    throw new UnauthorizedError("This refresh token was already used — the session has been revoked for safety. Please log in again.");
  }

  if (record.expiresAt < new Date()) {
    throw new UnauthorizedError("Refresh token has expired — please log in again.");
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId }, include: ROLE_WITH_PERMISSIONS_INCLUDE });
  if (!user || !user.isActive || !user.role.isActive) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    throw new UnauthorizedError("Account is no longer active");
  }

  const newRaw = generateOpaqueToken();
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: {
        userId: record.userId,
        familyId: record.familyId,
        tokenHash: hashToken(newRaw),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    }),
  ]);

  return { user, refreshToken: newRaw };
}

/** Revokes one refresh token (logout on one device) — no-op if it's already revoked, since
 * calling logout twice shouldn't error. Requires the caller to own the token, so a valid
 * access token for a *different* user can't be used to revoke someone else's session. */
export async function revokeRefreshToken(
  prisma: PrismaClient,
  rawToken: string,
  expectedUserId: string,
  context: RequestContext = {},
) {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!record || record.userId !== expectedUserId) {
    throw new UnauthorizedError("Invalid refresh token");
  }
  if (!record.revokedAt) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  }

  await recordActivity(prisma, {
    action: "LOGOUT",
    actorUserId: expectedUserId,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/** Live permission slugs for the given user — same freshness guarantee as authorize()'s
 * per-request check, just returning the whole set instead of testing one slug. Used to
 * hydrate frontend UI-gating; an inactive user or role resolves to an empty array rather
 * than throwing, since /auth/me should still succeed to show "you're deactivated" state. */
export async function getUserPermissionSlugs(prisma: PrismaClient, userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      role: {
        select: {
          isActive: true,
          permissions: { select: { permission: { select: { slug: true } } } },
        },
      },
    },
  });
  if (!user?.isActive || !user.role?.isActive) return [];
  return user.role.permissions.map((rp) => rp.permission.slug);
}
