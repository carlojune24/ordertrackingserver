import { z } from "zod";

export const createUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8).describe("Plain text in the request — hashed with bcrypt before storage, never stored or logged as-is."),
  roleId: z.string().describe("Must reference an active Role. See GET /roles for the current list."),
  assignedStationId: z.string().nullable().optional().describe("Restricts this user to scanning at exactly one dynamic production station (not QC/Packaging/Courier, which are fixed system stages). Leave unset/null for roles that aren't tied to one station, e.g. Supervisor or Management."),
});

export const updateUserBodySchema = z.object({
  name: z.string().min(1).optional(),
  password: z.string().min(8).optional().describe("Sets a new password. Omit to leave the current one unchanged."),
  roleId: z.string().optional().describe("Reassigning this takes effect immediately on the user's existing session — no re-login required, since authorization is always resolved live."),
  isActive: z.boolean().optional().describe("Set to false to revoke login access without deleting the account. Blocked with 409 if this would leave no active user able to manage users/roles."),
  assignedStationId: z.string().nullable().optional().describe("Set to a dynamic station's id to restrict scanning there, or null to clear the restriction. Must reference an active, non-system station."),
});

export const userIdParamsSchema = z.object({ id: z.string() });

export const listUsersQuerySchema = z.object({
  assignedStationId: z.string().optional().describe("Filter to users currently assigned to this exact station — e.g. \"who works Cutting?\"."),
  search: z.string().min(1).optional().describe("Matches against name and email, case-insensitive — e.g. for searching up an employee before pulling their performance report."),
});

const roleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const stationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  roleId: z.string(),
  role: roleSummarySchema,
  assignedStationId: z.string().nullable(),
  assignedStation: stationSummarySchema.nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
});

export const userListResponseSchema = z.array(userResponseSchema);
