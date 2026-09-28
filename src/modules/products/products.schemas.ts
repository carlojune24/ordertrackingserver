import { z } from "zod";

const imageInputSchema = z.object({
  url: z.string().url().describe("Must already be hosted somewhere — there's no upload endpoint."),
  sortOrder: z.number().int().optional().describe("Gallery display order — cosmetic only."),
  isPrimary: z.boolean().optional().describe("Flags the thumbnail/hero image. Not enforced as unique — if several are marked primary, pick the first."),
});

const colorLiningInputSchema = z.object({
  label: z.string().min(1).describe('e.g. "Black Lining", "Red Lining". Unique per product, not globally.'),
  sortOrder: z.number().int().optional(),
});

export const createProductBodySchema = z.object({
  categoryId: z.string(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  regularPrice: z.number().positive(),
  customizedPrice: z.number().positive().describe("What gets charged when an order item for this product is marked customized (see OrderItem.isCustomized) — a distinct base price, not a discount off regularPrice."),
  rating: z.number().min(0).max(5).optional().describe("A display score (e.g. from an existing storefront) — not computed from any review system in this app."),
  images: z.array(imageInputSchema).optional(),
  colorLinings: z.array(colorLiningInputSchema).optional().describe("If any are supplied (here or later), intake requires the customer to pick one. Leave empty for a product with no variant."),
});

export const updateProductBodySchema = z.object({
  categoryId: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  regularPrice: z.number().positive().optional(),
  customizedPrice: z.number().positive().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const listProductsQuerySchema = z.object({
  categoryId: z.string().optional().describe("Filter to one car brand's products."),
  includeInactive: z.coerce.boolean().optional(),
  search: z.string().min(1).optional().describe("Matches against name and description, case-insensitive."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const productIdParamsSchema = z.object({ id: z.string() });
export const productImageIdParamsSchema = z.object({ id: z.string(), imageId: z.string() });
export const productColorLiningIdParamsSchema = z.object({ id: z.string(), liningId: z.string() });

export const addProductImageBodySchema = imageInputSchema;
export const addColorLiningBodySchema = colorLiningInputSchema;
export const updateColorLiningBodySchema = z.object({
  label: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const productImageResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  sortOrder: z.number(),
  isPrimary: z.boolean(),
  createdAt: z.date(),
});

const colorLiningResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: z.date(),
});

const categorySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const productResponseSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  category: categorySummarySchema,
  name: z.string(),
  description: z.string().nullable(),
  regularPrice: z.number(),
  customizedPrice: z.number(),
  rating: z.number().nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  images: z.array(productImageResponseSchema),
  colorLinings: z.array(colorLiningResponseSchema),
});

export const productListResponseSchema = z.object({
  items: z.array(productResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const priceHistoryResponseSchema = z.array(
  z.object({
    id: z.string(),
    regularPrice: z.number(),
    customizedPrice: z.number(),
    createdAt: z.date(),
    changedBy: z.object({
      id: z.string(),
      name: z.string(),
      roleName: z.string().nullable(),
    }),
  }),
);
