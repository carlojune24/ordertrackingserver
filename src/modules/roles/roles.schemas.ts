import { z } from "zod";

export const createRoleBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  description: z.string().min(1).optional(),
  permissionSlugs: z.array(z.string()).describe("Every slug must exist in the permission catalog (GET /permissions) — unknown slugs are rejected with 400."),
});

export const updateRoleBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  description: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional().describe("Set to false to retire the role. Blocked with 409 if it's the last active role holding users.manage or roles.manage."),
  permissionSlugs: z
    .array(z.string())
    .optional()
    .describe(
      "If present, replaces the role's entire permission set (not a merge/diff). Blocked with 409 if removing users.manage or roles.manage would leave no active user able to manage users/roles.",
    ),
});

export const roleIdParamsSchema = z.object({ id: z.string() });

const permissionSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const roleResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  permissions: z.array(permissionSummarySchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const roleListResponseSchema = z.array(roleResponseSchema);
