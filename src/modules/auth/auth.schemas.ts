import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const permissionSlugsSchema = z.array(z.string()).describe("Every permission slug the user's current role holds, resolved live from the database at request time (same freshness guarantee as every authorize()-gated route) — not decoded from the token. Empty if the user or their role is deactivated. Intended for frontend UI-gating (show/hide controls); the backend enforces access independently on each route regardless of what this says.");

const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  assignedStationId: z.string().nullable().describe("The single dynamic (non-system) production station this user may scan at, if any — null for roles with no station restriction (e.g. Supervisor, Management)."),
  assignedStationName: z.string().nullable(),
  permissions: permissionSlugsSchema,
});

export const loginResponseSchema = z.object({
  token: z.string().describe("Short-lived access JWT (15 minutes) — send as Authorization: Bearer <token>."),
  refreshToken: z.string().describe("Long-lived opaque token (30 days), single-use — exchange it at POST /auth/refresh for a new token/refreshToken pair before (or right after) the access token expires. Store it as carefully as a password; anyone holding it can mint access tokens as this user until it's rotated or revoked."),
  user: authenticatedUserSchema,
});

export const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  roleId: z.string(),
  roleName: z.string().describe("Display-only, read straight from the token. Re-login (or refresh) to pick up a role rename; `permissions` below is more current since it's resolved live instead."),
  assignedStationId: z.string().nullable().describe("Display-only, read straight from the token — same freshness caveat as roleName. Any actual scan/reject action always re-checks this live server-side regardless of what the token says."),
  assignedStationName: z.string().nullable(),
  permissions: permissionSlugsSchema,
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export const refreshResponseSchema = z.object({
  token: z.string().describe("A new 15-minute access JWT."),
  refreshToken: z.string().describe("A new refresh token, replacing the one just spent — the old one is immediately revoked. Discard the old value and store this one instead; presenting the old one again is treated as token theft and revokes the entire session family."),
  user: authenticatedUserSchema,
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutResponseSchema = z.object({
  success: z.boolean(),
});
