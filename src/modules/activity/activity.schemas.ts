import { z } from "zod";
import { ActivityLogAction, ActivityLogEntityType } from "../../generated/prisma/enums";

export const listActivityQuerySchema = z.object({
  actorUserId: z.string().optional().describe("Filter to activity performed by this one user."),
  action: z.enum(ActivityLogAction).optional(),
  entityType: z.enum(ActivityLogEntityType).optional().describe("Filter to admin/config actions on this resource type. Has no effect on auth-event rows, which never carry an entityType."),
  entityId: z.string().optional().describe("Filter to actions on this one specific User/Role/Station/Category/Product."),
  from: z.coerce.date().optional().describe("Inclusive lower bound on createdAt."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on createdAt."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  roleName: z.string().nullable().describe("The actor's current role name — live, not a snapshot of what it was at the time of this event."),
});

const activityLogDtoSchema = z.object({
  id: z.string(),
  action: z.enum(ActivityLogAction),
  entityType: z.enum(ActivityLogEntityType).nullable(),
  entityId: z.string().nullable(),
  actorEmail: z.string().nullable().describe("Populated for auth events (login/logout/refresh-theft); null for admin/config actions."),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  message: z.string().nullable(),
  metadata: z.any().nullable(),
  createdAt: z.date(),
  actor: actorSchema.nullable().describe("Null only for a LOGIN_FAILURE against an email that never resolved to a known user."),
});

export const activityListResponseSchema = z.object({
  items: z.array(activityLogDtoSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
