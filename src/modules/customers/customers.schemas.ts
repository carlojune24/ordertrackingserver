import { z } from "zod";
import { OrderStatus } from "../../generated/prisma/enums";

export const createCustomerBodySchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional().describe("Unique across all customers — the field a future portal login will key off of."),
});

export const updateCustomerBodySchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
});

export const listCustomersQuerySchema = z.object({
  search: z.string().min(1).optional().describe("Matches name, phone, or email, case-insensitive."),
  includeArchived: z.coerce.boolean().optional().describe("Archived customers are excluded by default. Set true to include them alongside active customers in the listing."),
  archivedOnly: z.coerce.boolean().optional().describe("Show only archived customers. Overrides includeArchived when both are set."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const customerIdParamsSchema = z.object({ id: z.string() });

export const customerOrdersQuerySchema = z.object({
  status: z.enum(OrderStatus).optional(),
  includeArchived: z.coerce.boolean().optional().describe("Archived orders are excluded by default. Set true to include them alongside active orders."),
  archivedOnly: z.coerce.boolean().optional().describe("Show only this customer's archived orders. Overrides includeArchived when both are set."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const customerResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  orderCount: z.number().describe("Total orders ever placed by this customer (includes archived orders, not just active ones)."),
  isArchived: z.boolean().describe("Archived customers are fully frozen (edits rejected, can't be selected for a new or edited order) and excluded from GET /customers by default."),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const customerListResponseSchema = z.object({
  items: z.array(customerResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const customerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
