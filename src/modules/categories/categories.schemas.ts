import { z } from "zod";

export const createCategoryBodySchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only")
    .optional()
    .describe("Auto-derived from name if omitted — only pass this to override the derived value."),
  sortOrder: z.number().int().optional().describe("Display order in category lists — purely cosmetic, doesn't affect any workflow logic (unlike a Station's sortOrder)."),
  logoUrl: z.string().url().optional().describe("Must already be hosted somewhere. Prefer POST /categories/:id/logo/upload if you don't have a URL yet — that endpoint sets this field for you."),
});

export const updateCategoryBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional().describe("Set to false to retire the category from pickers without deleting it."),
  logoUrl: z.string().url().nullable().optional().describe("Set to null to clear the logo. If it currently points at a locally-uploaded file, that file is deleted."),
});

export const listCategoriesQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional().describe("Include retired (isActive: false) categories — off by default."),
});

export const categoryIdParamsSchema = z.object({ id: z.string() });

export const categoryResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  sortOrder: z.number(),
  logoUrl: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const categoryListResponseSchema = z.array(categoryResponseSchema);
