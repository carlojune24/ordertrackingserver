import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  loginBodySchema,
  loginResponseSchema,
  logoutBodySchema,
  logoutResponseSchema,
  meResponseSchema,
  refreshBodySchema,
  refreshResponseSchema,
} from "./auth.schemas";
import {
  ACCESS_TOKEN_TTL,
  getUserPermissionSlugs,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyLogin,
} from "./auth.service";
import type { JwtUserPayload } from "../../types/fastify";

export default async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Log in",
        description:
          "Exchanges email/password for a short-lived access JWT (15 minutes) plus a long-lived refresh token (30 days, single-use). The access token carries `sub` (user id), `email`, `name`, `roleId`, `roleName`, `assignedStationId`, and `assignedStationName` — send it as `Authorization: Bearer <token>` on every other request. All of these except `sub`/`email` are display-only; actual permission and station-assignment checks always re-resolve live from the database. `assignedStationId`/`assignedStationName` are null for roles with no station restriction (e.g. Supervisor, Management) — a Station Worker's own scanning UI should gate on this at login rather than requiring a separate lookup. Once the access token expires (or is about to), exchange the refresh token at `POST /auth/refresh` for a new pair instead of asking for credentials again — that's the intended flow for staying logged in through a shift. Fails with 401 for a wrong password or a deactivated (`isActive: false`) account or role.",
        body: loginBodySchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request) => {
      const { email, password } = request.body;
      const context = { ip: request.ip, userAgent: request.headers["user-agent"] };
      const user = await verifyLogin(fastify.prisma, email, password, context);
      const permissions = user.role.permissions.map((rp) => rp.permission.slug);

      const payload: JwtUserPayload = {
        sub: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.role.name,
        name: user.name,
        assignedStationId: user.assignedStationId,
        assignedStationName: user.assignedStation?.name ?? null,
      };
      const token = fastify.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_TTL });
      const refreshToken = await issueRefreshToken(fastify.prisma, user.id);

      return {
        token,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleId: user.roleId,
          roleName: user.role.name,
          assignedStationId: user.assignedStationId,
          assignedStationName: user.assignedStation?.name ?? null,
          permissions,
        },
      };
    },
  );

  app.post(
    "/refresh",
    {
      schema: {
        tags: ["Auth"],
        summary: "Refresh the access token",
        description:
          "Exchanges a still-valid refresh token for a brand-new access token + refresh token pair, without needing the password again. Rotate-on-use: the refresh token you send is immediately revoked and replaced — always store the new `refreshToken` from the response and discard the old one. Presenting an already-used (already-revoked) refresh token is treated as a sign the token was stolen: the entire chain of tokens descended from that login is revoked at once, and the legitimate holder is forced back to `POST /auth/login`. No `Authorization` header needed — the refresh token itself is the credential. 401s for an unknown, reused, expired, or already-revoked token, or if the account/role has been deactivated since it was issued.",
        body: refreshBodySchema,
        response: { 200: refreshResponseSchema },
      },
    },
    async (request) => {
      const context = { ip: request.ip, userAgent: request.headers["user-agent"] };
      const { user, refreshToken } = await rotateRefreshToken(fastify.prisma, request.body.refreshToken, context);
      const permissions = user.role.permissions.map((rp) => rp.permission.slug);

      const payload: JwtUserPayload = {
        sub: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.role.name,
        name: user.name,
        assignedStationId: user.assignedStationId,
        assignedStationName: user.assignedStation?.name ?? null,
      };
      const token = fastify.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_TTL });

      return {
        token,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleId: user.roleId,
          roleName: user.role.name,
          assignedStationId: user.assignedStationId,
          assignedStationName: user.assignedStation?.name ?? null,
          permissions,
        },
      };
    },
  );

  app.post(
    "/logout",
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ["Auth"],
        summary: "Log out (revoke a refresh token)",
        description:
          "Revokes the given refresh token so it can no longer be exchanged for new access tokens — ends the session on that one device/client. Doesn't touch the current access token itself (there's no revocation for those; it simply expires within 15 minutes on its own). Requires a valid access token, and the refresh token must belong to that same user. Already-revoked is treated as success (idempotent) rather than an error.",
        security: [{ bearerAuth: [] }],
        body: logoutBodySchema,
        response: { 200: logoutResponseSchema },
      },
    },
    async (request) => {
      const context = { ip: request.ip, userAgent: request.headers["user-agent"] };
      await revokeRefreshToken(fastify.prisma, request.body.refreshToken, request.user.sub, context);
      return { success: true };
    },
  );

  app.get(
    "/me",
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ["Auth"],
        summary: "Current user",
        description: "Returns the identity encoded in the current bearer token, plus a live-resolved `permissions` array — useful for hydrating the logged-in user and gating UI on app load without re-sending credentials. Unlike the rest of this response, `permissions` always reflects the database as of this call, not the token.",
        security: [{ bearerAuth: [] }],
        response: { 200: meResponseSchema },
      },
    },
    async (request) => {
      const { sub, email, name, roleId, roleName, assignedStationId, assignedStationName } = request.user;
      const permissions = await getUserPermissionSlugs(fastify.prisma, sub);
      return { id: sub, email, name, roleId, roleName, assignedStationId, assignedStationName, permissions };
    },
  );
}
